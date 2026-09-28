// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/ICoinDeployer.sol";
import "./interfaces/ICoinListingManager.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./Coin.sol";
import "./CoinCreator.sol";
import "./HolderRewards.sol";

// inspired by UniswapV3PoolDeployer

contract CoinDeployer is ICoinDeployer, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    /// @dev No trading fee or creator tax may exceed a tenth, and together they may not exceed a
    ///      fifth, whatever the owner sets.
    uint16 private constant MAX_FEE_BPS = 1_000;
    uint16 private constant MAX_TOTAL_FEE_BPS = 2_000;
    /// @dev A snipe tax is held below everything, so a taxed buy still buys something.
    uint16 private constant MAX_SNIPE_TAX_BPS = 9_900;
    uint32 private constant MAX_SNIPE_TAX_SECONDS = 60;
    uint256 private constant MAX_SNIPE_EXEMPTIONS = 32;
    /// @dev A reward coin's transfer fee is held to a twentieth of every transfer.
    uint16 private constant MAX_REWARD_FEE_BPS = 500;

    /// @notice An asset a coin may be paired with. Real-world assets, stablecoins, wrapped ether:
    ///         anything the owner lists, each with the reserve at which its coins graduate.
    struct QuoteAsset {
        /// @dev Reserve, in the asset's own raw units, at which a coin paired with it graduates.
        uint96 cap;
        uint8 decimals;
        /// @dev Whether new coins may be launched against it. Coins already launched keep going.
        bool enabled;
    }

    /// @notice The fee terms every coin launched from now on keeps for life. Changing them here
    ///         changes nothing for a coin already launched.
    struct FeeTerms {
        /// @dev The trading fee on every buy and sell, in basis points of the quote leg.
        uint16 feeBps;
        /// @dev The protocol's share of that fee; the creator gets the rest.
        uint16 protocolShareBps;
        /// @dev The most a creator may add on top as their own tax.
        uint16 maxCreatorTaxBps;
        /// @dev The snipe tax on a buy in the first second after launch, and how long it lasts.
        uint16 snipeTaxStartBps;
        uint32 snipeTaxSeconds;
    }

    /// @notice What a creator sends to launch a coin.
    struct LaunchParams {
        string name;
        string symbol;
        string description;
        string image;
        /// @dev Links, as one JSON string: {"x":"…","telegram":"…","website":"…"}.
        string socials;
        /// @dev The asset the coin is priced in; must be enabled here.
        address quoteAsset;
        /// @dev An opening buy in that asset's raw units, approved to this contract. Zero for none.
        uint256 preBuy;
        /// @dev Who receives the creator's fees. Zero means the launcher.
        address creatorFeeRecipient;
        /// @dev The creator's own tax on every trade, in basis points, up to the cap. Zero for none.
        uint16 creatorTaxBps;
        /// @dev A reward coin's share of every transfer for its holders, in basis points: zero for
        ///      a standard coin, up to 5%.
        uint16 rewardFeeBps;
        /// @dev A reward coin only: give every fee the creator would earn to the holders, for good.
        ///      `creatorFeeRecipient` must then be zero.
        bool shareFeesWithHolders;
    }

    uint32 public override allMemecoinsCount;
    address public immutable listingManager;
    address public immutable feeEscrow;
    /// @notice The contract that holds Coin's creation code and deploys every coin. Bound to
    ///         this factory once, after both are deployed.
    CoinCreator public immutable coinCreator;
    /// @notice The holder distributor every reward coin gets a clone of.
    address public immutable rewardsImplementation;
    ERC20Parameters internal _erc20Parameters;
    MemeCoinParameters internal _parameters;
    address[] public allMemecoins;
    /// @dev Index into `allMemecoins`, plus one so that zero means "not ours".
    mapping(address memecoin => uint32 indexPlusOne) internal _coinIndexPlusOne;

    /// @notice The assets a coin can be paired with, and what each graduates at.
    mapping(address token => QuoteAsset) public quoteAssets;
    /// @notice Every asset ever listed, enabled or not, so a menu can be read without an indexer.
    address[] public quoteAssetList;

    /// @notice Wallets a launch named as exempt from its snipe tax, beyond the creator's own.
    mapping(address memecoin => mapping(address account => bool)) public override isSnipeExempt;

    /// @notice The curve every coin launched from now on gets: a constant product, the quote
    ///         reserve times the token reserve, over reserves that start with a phantom quote and
    ///         `virtualTokenReserve` coins, PONS's model. The phantom quote is a share of the
    ///         asset's cap, so every asset gets the same shape and only the money unit differs.
    ///
    ///         At 40% of a 4.2 ETH cap a coin opens as if its curve held 1.68 ETH against a
    ///         billion coins: 1.68 ETH of FDV. It has sold 714.3M coins by the cap, at 12.25 times
    ///         the opening price; the pool opens with the 204.1M that match the raise at that
    ///         price, and the 81.6M left of the billion are locked at the dead address.
    uint16 public virtualQuoteBps = 4_000;
    uint128 public virtualTokenReserve = 1_000_000_000 ether;
    /// @notice Every coin's supply once graduated: what the curve sold, the pool's coins, and
    ///         the rest locked at the dead address.
    uint128 public maxSupply = 1_000_000_000 ether;

    /// @notice A 1% trading fee, 30% of it to the protocol and 70% to the creator; a creator tax
    ///         of up to 10% on top; and a snipe tax that opens at 99% and is gone three seconds
    ///         after launch. The same terms PONS trades on.
    FeeTerms public feeTerms = FeeTerms({
        feeBps: 100,
        protocolShareBps: 3_000,
        maxCreatorTaxBps: 1_000,
        snipeTaxStartBps: 9_900,
        snipeTaxSeconds: 3
    });
    /// @notice Paid in ether with every launch, to the treasury.
    uint256 public launchFee = 0.0005 ether;

    event MemeCoinDeployed(address indexed creator, address indexed memecoin, address indexed quoteAsset);
    event QuoteAssetSet(address indexed token, uint96 cap, uint8 decimals, bool enabled);
    event ParametersSet(uint16 virtualQuoteBps, uint128 virtualTokenReserve, uint128 maxSupply);
    event FeeTermsSet(uint16 feeBps, uint16 protocolShareBps, uint16 maxCreatorTaxBps, uint16 snipeTaxStartBps, uint32 snipeTaxSeconds);
    event LaunchFeeSet(uint256 launchFee);
    /// @notice A reward coin's terms: its distributor, the share of every transfer it takes, and
    ///         whether the creator's fees go to its holders.
    event RewardsConfigured(address indexed memecoin, address indexed distributor, uint16 rewardFeeBps, bool shareFeesWithHolders);

    constructor(
        address listingManager_,
        address feeEscrow_,
        CoinCreator coinCreator_,
        address rewardsImplementation_
    ) Ownable(msg.sender) {
        require(
            feeEscrow_ != address(0) && address(coinCreator_) != address(0) && rewardsImplementation_ != address(0),
            "Zero address"
        );
        rewardsImplementation = rewardsImplementation_;
        listingManager = listingManager_;
        feeEscrow = feeEscrow_;
        // Coin's creation code lives in the creator, not here, so this contract stays well
        // under the size limit however many rules the coin enforces.
        coinCreator = coinCreator_;
    }

    function erc20Parameters() external view returns (ERC20Parameters memory) {
        return _erc20Parameters;
    }

    function parameters() external view override returns (MemeCoinParameters memory) {
        return _parameters;
    }

    /// @notice The curve every coin launched from now on gets. Coins already launched keep theirs.
    ///         Pump.fun's terms, for one: a phantom quote of 30 / 85 of the cap, 1.073B coins in
    ///         the model and a billion in the coin.
    function setParameters(uint16 virtualQuoteBps_, uint128 virtualTokenReserve_, uint128 maxSupply_) public onlyOwner {
        require(virtualQuoteBps_ > 0 && virtualTokenReserve_ > 0 && maxSupply_ > 0, "Zero parameter");
        // The model's token side is what every quote measures from: a coin that ended with more
        // than it would leave that side negative once graduated.
        require(maxSupply_ <= virtualTokenReserve_, "Supply above the model");
        // What the curve sells by the cap and what the pool needs beside the raise, whatever the
        // asset: the pool's coins are the sold coins scaled by virtualQuote / (virtualQuote + cap).
        // The supply must hold both, or graduation would have to mint past it.
        uint256 sold = Math.mulDiv(virtualTokenReserve_, BPS, uint256(virtualQuoteBps_) + BPS);
        uint256 pooled = Math.mulDiv(sold, virtualQuoteBps_, uint256(virtualQuoteBps_) + BPS, Math.Rounding.Ceil);
        require(sold + pooled <= maxSupply_, "Supply below the curve");
        virtualQuoteBps = virtualQuoteBps_;
        virtualTokenReserve = virtualTokenReserve_;
        maxSupply = maxSupply_;
        emit ParametersSet(virtualQuoteBps_, virtualTokenReserve_, maxSupply_);
    }

    /// @notice The phantom quote reserve a coin priced in `quoteAsset` launches with, in the
    ///         asset's raw units: 1.68 ETH for a 4.2 ETH cap.
    function virtualQuoteOf(address quoteAsset) public view returns (uint256) {
        return (uint256(quoteAssets[quoteAsset].cap) * virtualQuoteBps) / BPS;
    }

    /// @notice The fee terms every coin launched from now on gets. Coins already launched keep
    ///         theirs: every one of these is an immutable on the coin.
    function setFeeTerms(FeeTerms calldata terms) external onlyOwner {
        require(terms.feeBps <= MAX_FEE_BPS && terms.maxCreatorTaxBps <= MAX_FEE_BPS, "Fee too high");
        require(terms.protocolShareBps <= BPS, "Bad share");
        require(terms.snipeTaxStartBps <= MAX_SNIPE_TAX_BPS, "Snipe tax too high");
        require(terms.snipeTaxSeconds <= MAX_SNIPE_TAX_SECONDS, "Snipe window too long");
        feeTerms = terms;
        emit FeeTermsSet(terms.feeBps, terms.protocolShareBps, terms.maxCreatorTaxBps, terms.snipeTaxStartBps, terms.snipeTaxSeconds);
    }

    /// @notice What a launch costs, in wei of ether.
    function setLaunchFee(uint256 fee) external onlyOwner {
        launchFee = fee;
        emit LaunchFeeSet(fee);
    }

    /// @notice Let coins be paired with `token`, graduating once their curve holds `cap` of it
    ///         (raw units), or stop offering it. Listing an asset again changes the cap for coins
    ///         launched from then on; a coin already launched keeps the cap it started with.
    ///
    ///         Only plain tokens belong here. The curve measures what it actually receives, but a
    ///         token that rebases or charges on transfer would still make its holders' claims
    ///         drift from the reserve, and the assets a platform lists are the platform's call.
    function setQuoteAsset(address token, uint96 cap, bool enabled) external onlyOwner {
        require(cap > 0, "Zero cap");
        require(token.code.length > 0, "Not a contract");
        uint8 decimals = IERC20Metadata(token).decimals();
        // Prices are stated at eighteen decimals, scaled up from the token's own.
        require(decimals <= 18, "Too many decimals");
        // A cap too small to carry a phantom quote would launch coins with no price (AUDIT-6 K-03).
        require(uint256(cap) * virtualQuoteBps >= BPS, "Cap too small");
        if (quoteAssets[token].cap == 0) quoteAssetList.push(token);
        quoteAssets[token] = QuoteAsset({cap: cap, decimals: decimals, enabled: enabled});
        emit QuoteAssetSet(token, cap, decimals, enabled);
    }

    /// @notice Every asset ever listed, in listing order. Check `quoteAssets` for whether each
    ///         still takes new coins.
    function allQuoteAssets() external view returns (address[] memory) {
        return quoteAssetList;
    }

    /// @notice Launch a coin priced in `params.quoteAsset`, paying the launch fee in ether.
    ///         `snipeExemptions` names wallets, beyond the creator's own, that buy untaxed in the
    ///         launch window: a team's bundle wallets, declared in the open.
    function deploy(
        LaunchParams calldata params,
        address[] calldata snipeExemptions
    ) public payable virtual returns (address memecoin) {
        QuoteAsset memory quote = quoteAssets[params.quoteAsset];
        require(quote.enabled, "Quote asset not enabled");
        require(msg.value == launchFee, "Launch fee not paid");
        FeeTerms memory terms = feeTerms;
        require(params.creatorTaxBps <= terms.maxCreatorTaxBps, "Creator tax too high");
        require(uint256(terms.feeBps) + params.creatorTaxBps <= MAX_TOTAL_FEE_BPS, "Total fee too high");
        require(snipeExemptions.length <= MAX_SNIPE_EXEMPTIONS, "Too many exemptions");
        require(params.rewardFeeBps <= MAX_REWARD_FEE_BPS, "Reward fee too high");
        if (params.shareFeesWithHolders) {
            require(params.rewardFeeBps > 0, "Sharing needs a reward coin");
            require(params.creatorFeeRecipient == address(0), "Fees go to holders");
        }

        // Register the coin before constructing it. Its address is known in advance, and its
        // constructor buys for the creator when money comes with the launch: that buy asks the
        // platform whether the coin is ours, which nothing could answer while the coin was
        // still being built (audit F-06).
        uint32 index = allMemecoinsCount;
        address predicted = getAddress(params.symbol);
        allMemecoins.push(predicted);
        _coinIndexPlusOne[predicted] = index + 1;
        unchecked {
            allMemecoinsCount = index + 1;
        }
        for (uint256 i = 0; i < snipeExemptions.length; i++) isSnipeExempt[predicted][snipeExemptions[i]] = true;
        address distributor = _cloneRewards(predicted, params);

        MemeCoinParameters storage p = _parameters;
        p.listingManager = listingManager;
        p.reserveToken = params.quoteAsset;
        p.cap = quote.cap;
        p.reserveDecimals = quote.decimals;
        p.virtualQuote = uint128(virtualQuoteOf(params.quoteAsset));
        // A curve with no phantom quote would open at a price of nothing and sell its whole
        // token side to the first buyer.
        require(p.virtualQuote > 0, "Cap too small");
        p.virtualTokenReserve = virtualTokenReserve;
        p.maxSupply = maxSupply;
        p.coinIndex = index;
        p.owner = msg.sender;
        p.feeEscrow = feeEscrow;
        p.creatorFeeRecipient = params.shareFeesWithHolders
            ? distributor
            : params.creatorFeeRecipient == address(0) ? msg.sender : params.creatorFeeRecipient;
        p.rewardDistributor = distributor;
        p.rewardFeeBps = params.rewardFeeBps;
        p.feeBps = terms.feeBps;
        p.protocolShareBps = terms.protocolShareBps;
        p.creatorTaxBps = params.creatorTaxBps;
        p.snipeTaxStartBps = terms.snipeTaxStartBps;
        p.snipeTaxSeconds = terms.snipeTaxSeconds;
        p.description = params.description;
        p.image = params.image;
        p.socials = params.socials;
        _erc20Parameters = ERC20Parameters({name: params.name, symbol: params.symbol});

        memecoin = coinCreator.create(keccak256(bytes(params.symbol)));
        require(memecoin == predicted, "Unexpected coin address");

        delete _parameters;
        delete _erc20Parameters;

        // The creator's opening buy lands before anyone else can trade, in this same transaction.
        uint256 paid = _collectPreBuy(params.quoteAsset, memecoin, params.preBuy);
        if (paid > 0) Coin(memecoin).launchBuy(paid);

        _payLaunchFee();
        emit MemeCoinDeployed(msg.sender, memecoin, params.quoteAsset);
    }

    /// @dev A reward coin's own distributor, cloned and bound to the coin's address before the
    ///      coin exists, so the coin can read it while it is built. None for a standard coin.
    function _cloneRewards(address memecoin, LaunchParams calldata params) private returns (address distributor) {
        if (params.rewardFeeBps == 0) return address(0);
        distributor = Clones.clone(rewardsImplementation);
        HolderRewards(distributor).initialize(memecoin, params.quoteAsset, feeEscrow);
        emit RewardsConfigured(memecoin, distributor, params.rewardFeeBps, params.shareFeesWithHolders);
    }

    /// @dev The launch fee is protocol revenue and goes where every other fee's protocol share goes.
    function _payLaunchFee() private {
        if (msg.value == 0) return;
        (bool ok, ) = ICoinListingManager(listingManager).treasury().call{value: msg.value}("");
        require(ok, "Treasury transfer failed");
    }

    /// @dev Moves the creator's opening buy to the coin, and measures what arrived, like every
    ///      other payment into a curve.
    function _collectPreBuy(address quoteAsset, address memecoin, uint256 preBuy) private returns (uint256 paid) {
        if (preBuy == 0) return 0;
        IERC20 token = IERC20(quoteAsset);
        uint256 before = token.balanceOf(memecoin);
        token.safeTransferFrom(msg.sender, memecoin, preBuy);
        paid = token.balanceOf(memecoin) - before;
    }

    /// @notice The reserve token per whole coin, scaled to 1e18, at the moment a coin paired
    ///         with `quoteAsset` fills its cap: the price its pool opens at, and Coin.price() at
    ///         the cap. (virtualQuote + cap) over the coins the model has left, which is
    ///         (1 + cap / virtualQuote)² times the opening price.
    function graduationPrice(address quoteAsset) public view returns (uint256 price) {
        QuoteAsset memory quote = quoteAssets[quoteAsset];
        require(quote.cap > 0, "Unknown quote asset");
        uint256 virtualQuote = virtualQuoteOf(quoteAsset);
        // With no phantom quote the model sells its whole token side by the cap, and there is
        // no price to close at; say so rather than divide by zero (AUDIT-6 K-03).
        require(virtualQuote > 0, "Cap too small");
        uint256 quoteReserve = virtualQuote + quote.cap;
        uint256 sold = Math.mulDiv(virtualTokenReserve, quote.cap, quoteReserve);
        uint256 scale = 10 ** (18 - quote.decimals);
        price = Math.mulDiv(quoteReserve * scale, 1e18, virtualTokenReserve - sold);
    }

    /// @notice Where a coin with `symbol` lives, or will: coins are deployed by the creator at an
    ///         address derived from the symbol alone.
    function getAddress(
        string memory symbol
    ) public view returns (address memecoin) {
        bytes32 salt = keccak256(bytes(symbol));
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(coinCreator),
                                salt,
                                coinCreator.initCodeHash()
                            )
                        )
                    )
                )
            );
    }

    /// @notice Whether this factory launched `memecoin`. Read from this contract's own
    ///         registry: asking the address itself panicked on an index it never issued and
    ///         could not answer for a contract still in its constructor (audit F-06, F-09).
    function isMemeCoinLegit(
        address memecoin
    ) public view override returns (bool) {
        return _coinIndexPlusOne[memecoin] != 0;
    }

    function allMemecoinsRange(
        uint startIndex,
        uint endIndex
    ) public view returns (address[] memory) {
        require(startIndex <= endIndex, "Invalid indices");
        require(endIndex < allMemecoins.length, "End index out of bounds");

        // Create a new array of the desired size
        address[] memory result = new address[](endIndex - startIndex + 1);

        // Copy the specified range of elements from the original array
        for (uint i = startIndex; i <= endIndex; i++) {
            result[i - startIndex] = allMemecoins[i];
        }

        return result;
    }
}
