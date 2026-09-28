// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/ICoinDeployer.sol";
import "./interfaces/ICoinListingManager.sol";
import "./ERC20Plus.sol";
import "./Formula.sol";
import "./HolderRewards.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title An outbidfun.lol coin
/// @notice An ERC20 with a bonding curve underneath it. The curve is priced in one asset, the
///         coin's reserve token, chosen by the creator from the assets the platform allows:
///         a buy pays that asset in, a sell takes it out, and when the reserve reaches the cap
///         the coin graduates into a pool against it. Every price this contract reports is the
///         reserve token per whole coin, scaled to 1e18 whatever the token's own decimals, so
///         a coin priced in a six-decimal dollar reads the same way as one priced in ether.
///
///         Every trade pays three things, all in the reserve token and never in the coin. A
///         trading fee, shared between the protocol and the creator at a split fixed for the
///         coin's life. A creator tax, chosen by the creator at launch, capped, never raisable,
///         and paid to the creator in full. And, on a buy in the first seconds after launch, a
///         snipe tax that starts near everything and falls to nothing within the window, which
///         is shared out the same way the trading fee is; the creator's own wallets are exempt.
///
///         A reward coin also takes a share of every transfer, in the coin itself, for its
///         holders: its distributor (`HolderRewards`) shares it out in proportion to what each
///         holds. Curve buys and sells count as transfers. What the platform moves for itself is
///         left alone — the graduation, the pool's own fees, coins sent to the dead address — and
///         so is anything sent into the coin's pool, because a Uniswap V3 pool rejects a payment
///         that arrives short. A reward coin's creator may also give every fee they would earn to
///         the holders, for good.
contract Coin is ERC20Plus, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 constant internal DECIMALS = 1e18;
    uint256 constant internal BPS = 10_000;
    /// @notice The most the creator's opening buy may take: three quarters of what the curve sells.
    uint256 public constant MAX_OPENING_BUY_BPS = 7_500;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable listingManager;
    address public immutable deployer;
    /// @notice The asset this coin is priced in and raises.
    address public immutable reserveToken;
    /// @notice The reserve token's decimals, so a price can be read in its whole units.
    uint8 public immutable reserveDecimals;
    /// @dev 10^(18 - reserveDecimals): a raw amount of the reserve token times this is the same
    ///      amount at eighteen decimals, which is how every price here is stated.
    uint256 internal immutable priceScale;
    /// @notice Reserve at which the curve closes, in the reserve token's raw units. Zero once
    ///         the coin has graduated: that is how everything here tells the two states apart.
    uint96 public cap;
    /// @notice The cap the coin launched with, kept after graduation so a raise can be read back.
    uint96 public immutable graduationCap;
    address internal immutable formula;
    uint16 internal immutable powerN;
    uint16 internal immutable powerD;
    /// @dev Coins the curve has sold by the time its reserve reaches the cap.
    uint128 internal immutable supplyAtCap;
    uint32 public immutable coinIndex;
    address public immutable owner;
    /// @notice When the coin launched, which the snipe tax counts from.
    uint64 public immutable launchedAt;

    /// @notice The trading fee on every buy and sell, in basis points of the reserve token leg.
    uint16 public immutable feeBps;
    /// @notice The protocol's share of the trading fee; the creator gets the rest.
    uint16 public immutable protocolShareBps;
    /// @notice The creator's own tax on top of the fee, paid to them in full. Fixed at launch.
    uint16 public immutable creatorTaxBps;
    /// @notice The snipe tax on a buy in the very first second, and how many seconds it lasts.
    uint16 public immutable snipeTaxStartBps;
    uint32 public immutable snipeTaxSeconds;
    /// @notice Where the creator's fees are credited for them to claim.
    address public immutable feeEscrow;
    /// @notice A reward coin's holder distributor; zero for a standard coin.
    address public immutable rewardDistributor;
    /// @notice The share of every transfer a reward coin takes for its holders, in basis points.
    uint16 public immutable rewardFeeBps;
    /// @notice A reward coin's pool, once it has graduated: coins sent into it pay no reward fee.
    address public pool;
    /// @notice Who the creator's fees are credited to. The current recipient can hand it on.
    address public creatorFeeRecipient;

    string public override description;
    string public override image;
    /// @notice The creator's links, as one JSON string.
    string public socials;

    /// @dev `liquidity` is what reached the curve, in the reserve token's raw units, after every
    ///      fee; `amount` is coins.
    event Buy(
        address indexed by,
        uint256 amount,
        uint256 liquidity,
        uint256 newSupply,
        uint256 timestamp // debug only
    );

    event Sell(
        address indexed by,
        uint256 amount,
        uint256 liquidity,
        uint256 newSupply,
        uint256 timestamp // debug only
    );

    /// @notice What a trade paid on top of what reached the curve: the fee (trading fee plus any
    ///         snipe tax, shared between protocol and creator) and the creator's tax.
    event FeesCharged(address indexed by, uint256 fee, uint256 tax);
    event CreatorFeeRecipientUpdated(address indexed previous, address indexed current);

    constructor() ERC20Plus(ICoinDeployer(ICoinCreator(_msgSender()).factory()).erc20Parameters()) {
        ICoinDeployer _deployer = ICoinDeployer(ICoinCreator(_msgSender()).factory());
        ICoinDeployer.MemeCoinParameters memory p = _deployer.parameters();
        listingManager = p.listingManager;
        reserveToken = p.reserveToken;
        reserveDecimals = p.reserveDecimals;
        cap = p.cap;
        graduationCap = p.cap;
        formula = p.formula;
        powerN = p.powerN;
        powerD = p.powerD;
        supplyAtCap = p.supplyAtCap;
        coinIndex = p.coinIndex;
        owner = p.owner;
        launchedAt = uint64(block.timestamp);
        feeBps = p.feeBps;
        protocolShareBps = p.protocolShareBps;
        creatorTaxBps = p.creatorTaxBps;
        snipeTaxStartBps = p.snipeTaxStartBps;
        snipeTaxSeconds = p.snipeTaxSeconds;
        feeEscrow = p.feeEscrow;
        rewardDistributor = p.rewardDistributor;
        rewardFeeBps = p.rewardFeeBps;
        creatorFeeRecipient = p.creatorFeeRecipient;
        description = p.description;
        image = p.image;
        socials = p.socials;
        deployer = address(_deployer);

        // The deployer has checked the asset, its decimals, the curve and the fee terms; the cap
        // is the one thing this contract reads back for itself, because a zero cap would read
        // as listed.
        require(p.cap > 0, 'Positive cap expected');
        priceScale = 10 ** (18 - p.reserveDecimals);
        // The creator's share of every fee goes to the escrow, which pulls it from here.
        IERC20(p.reserveToken).forceApprove(p.feeEscrow, type(uint256).max);
    }

    /// @notice The creator's opening buy, in the transaction that launches the coin. The factory
    ///         moves the payment here before constructing the coin, since the address is known
    ///         in advance, and calls this straight after; nothing else can, and it only answers
    ///         while the coin has no supply, so it cannot be a second buy for anyone. Kept out
    ///         of the constructor so the curve's code is not carried in the creation code as well.
    function launchBuy(uint256 payment) external {
        require(_msgSender() == deployer, 'Not the deployer');
        require(totalSupply() == 0, 'Already trading');
        // It cannot fill the cap: graduation asks the listing manager, which the factory has
        // not finished registering the coin with until launch returns.
        require(payment < cap, 'Pre-buy exceeds cap');
        _mintCoin(owner, payment, 0);
        require(totalSupply() <= (uint256(supplyAtCap) * MAX_OPENING_BUY_BPS) / BPS, 'Opening buy over 75%');
    }

    modifier notListed() {
        require(cap > 0, 'Already listed');
        _;
    }

    /// @notice Hands future creator fees to `recipient`. Only the current recipient may.
    function setCreatorFeeRecipient(address recipient) external {
        require(_msgSender() == creatorFeeRecipient, 'Not the fee recipient');
        require(recipient != address(0), 'Zero recipient');
        emit CreatorFeeRecipientUpdated(creatorFeeRecipient, recipient);
        creatorFeeRecipient = recipient;
    }

    /// @notice The snipe tax a buy from `buyer` would pay right now, in basis points. Zero for
    ///         the creator's own wallets, the wallets the launch named, and once the launch
    ///         window has passed. It falls in a straight line to nothing across the window: over
    ///         three seconds, 99% at launch, 66% a second later, 33% after two, none after three.
    function snipeTaxBps(address buyer) public view returns (uint256) {
        uint256 elapsed = block.timestamp - launchedAt;
        if (snipeTaxStartBps == 0 || elapsed >= snipeTaxSeconds) return 0;
        if (buyer == owner || buyer == creatorFeeRecipient) return 0;
        if (ICoinDeployer(deployer).isSnipeExempt(address(this), buyer)) return 0;
        return (uint256(snipeTaxStartBps) * (snipeTaxSeconds - elapsed)) / snipeTaxSeconds;
    }

    /// @notice True when the creator gave every fee they would earn to the coin's holders.
    function sharesFeesWithHolders() public view returns (bool) {
        return rewardDistributor != address(0) && creatorFeeRecipient == rewardDistributor;
    }

    /// @notice The reward fee on `amount` coins moving: what a reward coin keeps for its holders.
    function rewardFeeOn(uint256 amount) public view returns (uint256) {
        return (amount * rewardFeeBps) / BPS;
    }

    /// @dev Every balance change on a reward coin: takes the reward fee from a transfer that owes
    ///      one, then reports both sides' balances to the distributor. A standard coin has no
    ///      distributor and does neither.
    function _update(address from, address to, uint256 value) internal override {
        address distributor = rewardDistributor;
        if (distributor == address(0)) {
            super._update(from, to, value);
            return;
        }
        if (from != address(0) && to != address(0) && !_feeFree(from, to)) {
            uint256 fee = rewardFeeOn(value);
            if (fee > 0) {
                super._update(from, distributor, fee);
                value -= fee;
            }
        }
        super._update(from, to, value);
        address a = _holder(from);
        address b = _holder(to);
        if (a != address(0) || b != address(0)) {
            HolderRewards(distributor).updateShares(a, a == address(0) ? 0 : balanceOf(a), b, b == address(0) ? 0 : balanceOf(b));
        }
    }

    /// @dev Transfers the platform makes for itself, and anything paid into the pool. A payment
    ///      into the fee escrow is not one of them: anyone may credit anyone there, so an untaxed
    ///      way in would be a free wallet-to-wallet transfer. The platform's own credits come from
    ///      the listing manager, which is exempt as the sender; a claim out of the escrow is too.
    function _feeFree(address from, address to) private view returns (bool) {
        return
            from == rewardDistributor || to == rewardDistributor ||
            from == listingManager || to == listingManager ||
            from == feeEscrow ||
            to == DEAD || (to == pool && to != address(0));
    }

    /// @dev `account` if its balance counts toward rewards, zero if it holds for the platform.
    function _holder(address account) private view returns (address) {
        if (
            account == address(0) || account == rewardDistributor || account == listingManager ||
            account == feeEscrow || account == DEAD || account == address(this) || account == pool
        ) return address(0);
        return account;
    }

    /// @notice Graduates a curve whose reserve has reached its cap without a buy filling it:
    ///         reserve pushed in from outside, which would otherwise refuse every buy — and every
    ///         bid — until someone sold (AUDIT-3 H-04). Anyone may call. What sits above the cap is
    ///         protocol revenue, the way reserve pushed into an empty curve already is.
    function graduate() external notListed nonReentrant {
        require(IERC20(reserveToken).balanceOf(address(this)) >= cap, 'Curve not full');
        _listing(ICoinListingManager(listingManager).treasury());
    }

    /// @dev Moves the curve's reserve and matching fresh supply into a pool the listing manager
    ///      opens at the price the curve reached, and sends whatever is left over to `changeTo`:
    ///      the buyer's change from a buy that filled the curve. The price is read before the
    ///      listing mint changes the supply, and the curve is closed before anything external runs.
    function _listing(address changeTo) internal {
        uint256 _cap = cap;
        // The curve's reserve is the cap; any leftover in the balance is the buyer's change.
        uint256 listingPrice = _priceAt(_cap, totalSupply());
        delete cap;

        ICoinListingManager _listingManager = ICoinListingManager(listingManager);
        uint256 amountTokenForListing = _listingManager.tokensForListing(address(this), _cap, listingPrice);
        _mint(address(_listingManager), amountTokenForListing);
        IERC20 token = IERC20(reserveToken);
        token.safeTransfer(address(_listingManager), _cap);
        _listingManager.listMemeCoin(amountTokenForListing, _cap, listingPrice);
        address distributor = rewardDistributor;
        if (distributor != address(0)) {
            // The pool was funded before its address was known here, so it was counted as a
            // holder for that moment. It holds for the market, not for itself: drop it.
            address pool_ = _listingManager.poolOf(address(this));
            pool = pool_;
            HolderRewards(distributor).updateShares(pool_, 0, address(0), 0);
        }

        uint256 leftover = token.balanceOf(address(this));
        if (leftover > 0) token.safeTransfer(changeTo, leftover);
    }

    /// @notice What the curve holds, in the reserve token's raw units.
    function reserveBalance() public view virtual returns (uint256) {
        return IERC20(reserveToken).balanceOf(address(this));
    }

    /// @notice The reserve token per whole coin at the current supply, scaled to 1e18.
    function price() public view returns (uint256) {
        return _priceAt(reserveBalance(), totalSupply());
    }

    /// @dev The curve is reserve = k * supply ^ (1 + powerN / powerD), so its marginal price is
    ///      (1 + powerN / powerD) * reserve / supply. Read from the two balances this is exact
    ///      arithmetic; raising the supply to a large power is not (audit F-18), and below one
    ///      whole coin it used to panic outright (audit F-10).
    function _priceAt(uint256 reserve, uint256 supply) private view returns (uint256) {
        if (supply == 0) return 0;
        return Math.mulDiv(reserve * (uint256(powerN) + powerD) * priceScale, DECIMALS, supply * powerD);
    }

    /// @dev Pays out `fee` and `tax` of the reserve token: the protocol's share of the fee to
    ///      the treasury, the rest of the fee and the whole tax to the creator's escrow balance.
    function _payFees(address trader, uint256 fee, uint256 tax) private {
        uint256 toProtocol = (fee * protocolShareBps) / BPS;
        uint256 toCreator = fee - toProtocol + tax;
        if (toProtocol > 0) {
            IERC20(reserveToken).safeTransfer(ICoinListingManager(listingManager).treasury(), toProtocol);
        }
        if (toCreator > 0) {
            // Shared with holders: paid straight to the distributor, which counts it on the next
            // transfer. Otherwise credited to the creator, who claims it from the escrow.
            if (sharesFeesWithHolders()) IERC20(reserveToken).safeTransfer(rewardDistributor, toCreator);
            else IFeeEscrow(feeEscrow).credit(creatorFeeRecipient, reserveToken, toCreator);
        }
        emit FeesCharged(trader, fee, tax);
    }

    /// @notice Mints coins for `payment` of the reserve token, which is already in this contract.
    function _mintCoin(address minter, uint256 payment, uint256 minAmount) internal virtual {
        uint256 _cap = cap;
        IERC20 token = IERC20(reserveToken);
        uint256 reserve = token.balanceOf(address(this)) - payment;

        // Reserve pushed into an empty curve has no holder to belong to, and whoever bought next
        // could mint a sliver of supply and sell it for the lot (audit G-03). It is protocol
        // revenue. On a live curve, pushed-in reserve is simply shared by the holders.
        if (totalSupply() == 0 && reserve > 0) {
            token.safeTransfer(ICoinListingManager(listingManager).treasury(), reserve);
            reserve = 0;
        }

        // The fees come off the top and the curve takes the rest. A buy that fills the cap
        // spends only what fits, and the fees follow the spend rather than the payment, so
        // nobody is charged for money that comes straight back (audit F-16).
        uint256 rate = uint256(feeBps) + creatorTaxBps + snipeTaxBps(minter);
        // In the launch second the snipe tax alone is 99%: with the fee, and any creator tax, a
        // stranger's buy would pay everything or more. Say so, rather than mint nothing or panic.
        require(rate < BPS, "Snipe tax: too early");
        uint256 value = payment - (payment * rate) / BPS;
        // Reserve can be pushed in from outside; if that has already filled the cap, say so
        // rather than underflow (audit G-03). A sell brings the reserve back under it.
        require(reserve < _cap, 'Curve is full');
        uint256 room = _cap - reserve;
        if (value > room) {
            value = room;
            uint256 spend = Math.ceilDiv(value * BPS, BPS - rate);
            if (spend < payment) payment = spend;
        }
        uint256 tax = (payment * creatorTaxBps) / BPS;
        _payFees(minter, payment - value - tax, tax);

        uint256 amount = _calculatePurchaseReturn(reserve, value);
        // A buy too small to move the curve used to keep the money and mint nothing (audit F-07).
        require(amount > 0, "Zero output token amount");
        // A reward coin keeps its share of what the curve mints; the buyer's minimum is of the rest.
        uint256 rewardFee = rewardFeeOn(amount);
        require(amount - rewardFee >= minAmount, "Insufficient output token amount");
        if (rewardFee > 0) _mint(rewardDistributor, rewardFee);
        _mint(minter, amount - rewardFee);
        emit Buy(minter, amount - rewardFee, value, totalSupply(), block.timestamp);

        if (token.balanceOf(address(this)) >= _cap) _listing(_msgSender());
    }

    /// @notice Pays `amountIn` of the reserve token, approved to this contract, for coins.
    /// @param minAmount The minimum amount of coins the buyer expects to receive
    function buy(uint256 amountIn, uint256 minAmount) external virtual notListed nonReentrant {
        IERC20 token = IERC20(reserveToken);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(_msgSender(), address(this), amountIn);
        // Measured rather than trusted, so a token that takes a cut in transit cannot mint
        // coins for money the curve never received.
        uint256 received = token.balanceOf(address(this)) - before;
        _mintCoin(_msgSender(), received, minAmount);
    }

    /// @notice Retires coins of given amount, and pays out the reserve token they are worth
    /// @param amount The amount of coins being retired
    /// @param minValue The minimum reserve the seller expects to receive, in raw units
    /// @dev Burns before it pays, so no re-entrant call can trade against a supply that has
    ///      already been sold (audit F-08). The quote is taken first, while the reserve and the
    ///      supply still belong together.
    function sell(uint256 amount, uint256 minValue) external virtual notListed nonReentrant {
        // A sale of nothing used to succeed and record a trade of nothing (audit G-05).
        require(amount > 0, "Zero sale amount");
        require(amount <= totalSupply(), "Retire Amount Exceeds Supply");
        // A reward coin keeps its share of the coins sold for its holders; the curve buys the rest.
        uint256 rewardFee = rewardFeeOn(amount);
        uint256 sold = amount - rewardFee;
        uint256 gross = calculateSaleReturn(sold);

        uint256 fee = (gross * feeBps) / BPS;
        uint256 tax = (gross * creatorTaxBps) / BPS;
        uint256 liquidity = gross - fee - tax;
        require(liquidity >= minValue, "Insufficient output amount");

        address msgSender = _msgSender();
        if (rewardFee > 0) _update(msgSender, rewardDistributor, rewardFee);
        _burn(msgSender, sold);
        emit Sell(msgSender, sold, liquidity, totalSupply(), block.timestamp);

        _payFees(msgSender, fee, tax);
        IERC20(reserveToken).safeTransfer(msgSender, liquidity);
    }

    /// @dev Coins the curve owes for `_depositValue` added to a reserve of `_reserve`.
    ///
    ///      The supply the curve reaches is kept whole, fraction and all. Flooring it to whole
    ///      coins made a small buy land on the supply it started from, minting nothing while
    ///      keeping the money, and made one after a partial sell land below it and panic
    ///      (audit F-07).
    function _calculatePurchaseReturn(
        uint256 _reserve,
        uint256 _depositValue
    ) internal view returns (uint256) {
        uint32 powerNOfPowerPlus1 = uint32(powerN) + powerD;
        uint256 reserve = _reserve;
        uint256 supply = totalSupply();
        uint256 newSupply;

        if (reserve == 0 || supply == 0) {
            // The first money in, or a curve that was sold out: the supply has to be found
            // from the reserve alone, measured against the cap so the evaluation stays exact
            // (audit G-01). Written as a difference so that it stays right whatever the
            // reserve already holds.
            Formula f = Formula(formula);
            uint256 minted = f.supplyAt(reserve + _depositValue, cap, supplyAtCap, powerN, powerD)
                - f.supplyAt(reserve, cap, supplyAtCap, powerN, powerD);
            newSupply = supply + minted;
        } else {
            // supply * (1 + deposit / reserve) ^ (powerD / powerNOfPowerPlus1). Moving from
            // where the curve already is keeps the base near one, which is the range the
            // power function is exact in (audit F-18).
            (uint256 result, uint8 precision) = Formula(formula).power(
                reserve + _depositValue,
                reserve,
                powerD,
                powerNOfPowerPlus1
            );
            newSupply = Math.mulDiv(supply, result, uint256(1) << precision);
        }
        return newSupply > supply ? newSupply - supply : 0;
    }

    /// @notice Coins a deposit of `_depositValue` raw units of the reserve token buys right now,
    ///         once the fees have come off it.
    function calculatePurchaseReturn(
        uint256 _depositValue
    ) external view returns (uint256) {
        return _calculatePurchaseReturn(reserveBalance(), _depositValue);
    }

    /// @notice Reserve the curve pays for `_saleAmount` coins, before the fees.
    ///
    ///         Like a buy, this is measured from where the curve is rather than from the
    ///         supply alone: the reserve left is `reserve / (supply / newSupply) ^ 2.2`, whose
    ///         base is near one for any ordinary sale. Raising the supply itself to that power
    ///         asked the curve's power function for an exponent it answers 87% short of, which
    ///         paid a seller most of the reserve for half the supply (audit F-18).
    function calculateSaleReturn(
        uint256 _saleAmount
    ) public view returns (uint256) {
        uint256 supply = totalSupply();
        // Answer a quote for more than exists with a reason, not a panic (audit G-06).
        require(_saleAmount <= supply, "Retire Amount Exceeds Supply");
        uint256 reserve = reserveBalance();
        uint256 newSupply = supply - _saleAmount;
        if (newSupply == 0) return reserve;

        uint32 powerNOfPowerPlus1 = uint32(powerN) + powerD;
        (uint256 result, uint8 precision) = Formula(formula).power(
            supply,
            newSupply,
            powerNOfPowerPlus1,
            powerD
        );
        uint256 remaining = Math.mulDiv(reserve, uint256(1) << precision, result);
        return reserve - remaining;
    }
}
