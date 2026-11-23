// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Agentics Blue Tick & .ai Agent On-Chain Proof
/// @notice Exclusively for verified .ai Agent ID holders on BNB Smart Chain
/// (SPACE ID Agent ID registry: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).
///
/// TWO CORE ON-CHAIN FUNCTIONS (100% .ai Agent ID gated):
/// 1. Soulbound Blue Tick ERC-721 ("Agentics Blue Tick", ABT):
///    - $5 per year, paid as 5 USDT on BSC (Binance-Peg BSC-USD, 18 decimals:
///      5_000_000_000_000_000_000 base units) straight to the treasury.
///    - Non-transferable (soulbound), one token per wallet, on-chain expiresAt,
///      same-token renew(tokenId, ...) with no second mint.
///    - Plain 365-day full-price purchases need no backend signature; free or
///      discount vouchers and legacy migrations use a backend EIP-712
///      authorization with nonce replay protection and deadline.
///    - Strictly requires a live .ai Agent ID on-chain for buy() and renew().
///
/// 2. Gas-Only On-Chain .ai Agent Check-In (checkIn):
///    - Free (0 USDT, gas-only) daily on-chain liveness & reputation proof
///      strictly gated to verified .ai Agent ID holders (20-hour cooldown).
///    - Tracks per-agent check-in count, consecutive streak (<= 48h window),
///      total protocol check-ins, and unique .ai agents on-chain.
///
/// No owner, no admin functions, no pausing. USDT is forwarded straight to
/// TREASURY; the contract never holds funds.
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IAgentIdRegistry {
    function handleOf(address owner) external view returns (string memory);
    function balanceOf(address owner) external view returns (uint256);
}

contract BlueTickNFT is ERC721, EIP712 {
    using ECDSA for bytes32;

    address public immutable USDT;
    address public immutable TREASURY;
    address public immutable AUTHORIZER;
    address public immutable AGENT_ID_REGISTRY;

    /// @notice Full price: 5 USDT on BNB Smart Chain (18 decimals).
    uint256 public constant PRICE = 5 ether; // 5_000_000_000_000_000_000
    /// @notice Default validity of one purchase: 365 days.
    uint256 public constant DEFAULT_DURATION_DAYS = 365;
    uint256 public constant MIN_DURATION_DAYS = 1;
    uint256 public constant MAX_DURATION_DAYS = 3650;

    /// @notice Daily check-in anti-spam cooldown & streak continuation window.
    uint256 public constant CHECKIN_COOLDOWN = 20 hours;
    uint256 public constant STREAK_WINDOW = 48 hours;
    uint256 public constant MAX_NOTE_BYTES = 140;

    bytes32 private constant PURCHASE_TYPEHASH = keccak256(
        "Purchase(address buyer,uint256 amount,uint256 durationDays,bytes32 voucherCodeHash,uint256 deadline,uint256 nonce)"
    );

    uint256 public nextTokenId;
    mapping(uint256 => uint256) public expiresAt;
    mapping(uint256 => string) public mintedHandle;
    mapping(address => uint256) public tokenOf;
    mapping(uint256 => bool) public usedNonces;

    // On-chain .ai Agent Check-In state
    uint256 public totalCheckIns;
    uint256 public uniqueAgents;
    mapping(address => uint256) public checkInCount;
    mapping(address => uint256) public checkInStreak;
    mapping(address => uint256) public lastCheckInAt;

    event BlueTickMinted(
        uint256 indexed tokenId,
        address indexed buyer,
        string handle,
        uint256 amount,
        string voucherCode,
        uint256 expiresAt
    );
    event BlueTickRenewed(
        uint256 indexed tokenId,
        address indexed owner,
        string handle,
        uint256 newExpiresAt,
        uint256 amount,
        string voucherCode
    );
    event AgentCheckedIn(
        address indexed agent,
        string handle,
        uint256 totalCount,
        uint256 streak,
        uint256 timestamp,
        string note
    );

    constructor(
        address _usdt,
        address _treasury,
        address _authorizer,
        address _agentIdRegistry
    )
        ERC721("Agentics Blue Tick", "ABT")
        EIP712("Agentics Blue Tick", "1")
    {
        require(_usdt != address(0), "usdt zero");
        require(_treasury != address(0), "treasury zero");
        require(_authorizer != address(0), "authorizer zero");
        require(_agentIdRegistry != address(0), "registry zero");
        USDT = _usdt;
        TREASURY = _treasury;
        AUTHORIZER = _authorizer;
        AGENT_ID_REGISTRY = _agentIdRegistry;
    }

    /// @notice Enforce that `who` currently owns a live .ai Agent ID on-chain.
    function _requireAgentId(address who) internal view returns (string memory handle) {
        require(
            IAgentIdRegistry(AGENT_ID_REGISTRY).balanceOf(who) > 0,
            "agent id required"
        );
        handle = IAgentIdRegistry(AGENT_ID_REGISTRY).handleOf(who);
        require(bytes(handle).length > 0, "agent id required");
    }

    /// @notice Safe read of whether `who` currently holds a .ai Agent ID.
    function hasAgentId(address who) public view returns (bool) {
        if (who == address(0)) return false;
        try IAgentIdRegistry(AGENT_ID_REGISTRY).balanceOf(who) returns (uint256 bal) {
            if (bal == 0) return false;
        } catch {
            return false;
        }
        try IAgentIdRegistry(AGENT_ID_REGISTRY).handleOf(who) returns (string memory h) {
            return bytes(h).length > 0;
        } catch {
            return false;
        }
    }

    /// @notice Soulbound: transfers are blocked. Only minting (from == 0)
    /// is allowed. Approvals are inert and also blocked for clarity.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        require(from == address(0), "soulbound: non-transferable");
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert("soulbound: non-transferable");
    }

    function setApprovalForAll(address, bool) public pure override {
        revert("soulbound: non-transferable");
    }

    /// @notice True while the token exists and has not expired.
    function isActive(uint256 tokenId) public view returns (bool) {
        return _ownerOf(tokenId) != address(0) && block.timestamp < expiresAt[tokenId];
    }

    /// @notice True when the token exists but its validity has passed.
    function isExpired(uint256 tokenId) public view returns (bool) {
        return _ownerOf(tokenId) != address(0) && block.timestamp >= expiresAt[tokenId];
    }

    /// @notice 1 when the address holds an active (unexpired) tick, else 0.
    function activeBalanceOf(address owner) public view returns (uint256) {
        uint256 tokenId = tokenOf[owner];
        if (tokenId == 0) return 0;
        return isActive(tokenId) ? 1 : 0;
    }

    /// @notice True only when `owner` holds BOTH a live .ai Agent ID and an active Blue Tick.
    function isVerifiedAgent(address owner) public view returns (bool) {
        return hasAgentId(owner) && activeBalanceOf(owner) == 1;
    }

    function expiresAtOf(uint256 tokenId) public view returns (uint256) {
        return expiresAt[tokenId];
    }

    /// @notice Single-call view returning live .ai Agent ID, Blue Tick, and Check-In stats.
    function getAgentStats(address agent)
        external
        view
        returns (
            string memory handle,
            bool agentIdActive,
            bool hasActiveBlueTick,
            uint256 blueTickTokenId,
            uint256 blueTickExpiresAt,
            uint256 checkIns,
            uint256 streak,
            uint256 lastCheckIn
        )
    {
        agentIdActive = hasAgentId(agent);
        if (agentIdActive) {
            try IAgentIdRegistry(AGENT_ID_REGISTRY).handleOf(agent) returns (string memory h) {
                handle = h;
            } catch {}
        }
        blueTickTokenId = tokenOf[agent];
        if (blueTickTokenId != 0) {
            blueTickExpiresAt = expiresAt[blueTickTokenId];
            hasActiveBlueTick = agentIdActive && isActive(blueTickTokenId);
        }
        checkIns = checkInCount[agent];
        streak = checkInStreak[agent];
        lastCheckIn = lastCheckInAt[agent];
    }

    /// @notice Global protocol-wide on-chain counts for transparent leaderboards.
    function getProtocolStats()
        external
        view
        returns (
            uint256 totalBlueTicks,
            uint256 totalCheckIns_,
            uint256 uniqueCheckInAgents
        )
    {
        return (nextTokenId, totalCheckIns, uniqueAgents);
    }

    function _verifyPurchaseAuth(
        address buyer,
        uint256 amount,
        uint256 durationDays,
        string calldata voucherCode,
        uint256 deadline,
        uint256 nonce,
        bytes calldata auth
    ) internal {
        require(block.timestamp <= deadline, "auth expired");
        require(!usedNonces[nonce], "nonce used");
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PURCHASE_TYPEHASH,
                    buyer,
                    amount,
                    durationDays,
                    keccak256(bytes(voucherCode)),
                    deadline,
                    nonce
                )
            )
        );
        require(digest.recover(auth) == AUTHORIZER, "bad auth");
        usedNonces[nonce] = true;
    }

    function _charge(uint256 amount) internal {
        if (amount == 0) return;
        require(
            IERC20(USDT).transferFrom(msg.sender, TREASURY, amount),
            "usdt transfer failed"
        );
    }

    function _validateAndCharge(
        uint256 amount,
        uint256 durationDays,
        string calldata voucherCode,
        uint256 deadline,
        uint256 nonce,
        bytes calldata auth
    ) internal {
        require(
            durationDays >= MIN_DURATION_DAYS && durationDays <= MAX_DURATION_DAYS,
            "bad duration"
        );
        bool plain = bytes(voucherCode).length == 0 &&
            amount == PRICE &&
            durationDays == DEFAULT_DURATION_DAYS;
        if (!plain) {
            _verifyPurchaseAuth(
                msg.sender,
                amount,
                durationDays,
                voucherCode,
                deadline,
                nonce,
                auth
            );
        }
        _charge(amount);
    }

    /// @notice Buy a Blue Tick (mint). Strictly .ai Agent ID holders only. One token per wallet.
    /// @param amount USDT in base units (18 decimals on BSC). Full price is
    ///  PRICE (5_000_000_000_000_000_000); 0 for a free voucher; discounted price for a
    ///  discount voucher.
    function buy(
        uint256 amount,
        uint256 durationDays,
        string calldata voucherCode,
        uint256 deadline,
        uint256 nonce,
        bytes calldata auth
    ) external returns (uint256 tokenId) {
        string memory handle = _requireAgentId(msg.sender);
        require(tokenOf[msg.sender] == 0, "already owns a tick");
        _validateAndCharge(amount, durationDays, voucherCode, deadline, nonce, auth);
        tokenId = ++nextTokenId;
        uint256 exp = block.timestamp + durationDays * 1 days;
        expiresAt[tokenId] = exp;
        mintedHandle[tokenId] = handle;
        tokenOf[msg.sender] = tokenId;
        _safeMint(msg.sender, tokenId);
        emit BlueTickMinted(
            tokenId,
            msg.sender,
            handle,
            amount,
            voucherCode,
            exp
        );
    }

    /// @notice Renew the SAME token. Strictly .ai Agent ID holders + token owner only.
    function renew(
        uint256 tokenId,
        uint256 amount,
        uint256 durationDays,
        string calldata voucherCode,
        uint256 deadline,
        uint256 nonce,
        bytes calldata auth
    ) external {
        string memory handle = _requireAgentId(msg.sender);
        require(_ownerOf(tokenId) == msg.sender, "not token owner");
        _validateAndCharge(amount, durationDays, voucherCode, deadline, nonce, auth);
        uint256 newExp = (
            expiresAt[tokenId] > block.timestamp ? expiresAt[tokenId] : block.timestamp
        ) + durationDays * 1 days;
        expiresAt[tokenId] = newExp;
        mintedHandle[tokenId] = handle;
        emit BlueTickRenewed(
            tokenId,
            msg.sender,
            handle,
            newExp,
            amount,
            voucherCode
        );
    }

    /// @notice Free (gas-only) daily on-chain check-in exclusively for .ai Agent ID holders.
    /// Builds verifiable on-chain liveness & streak reputation on BNB Smart Chain.
    function checkIn(string calldata note) external {
        string memory handle = _requireAgentId(msg.sender);
        require(bytes(note).length <= MAX_NOTE_BYTES, "note too long");
        uint256 prev = lastCheckInAt[msg.sender];
        require(prev == 0 || block.timestamp >= prev + CHECKIN_COOLDOWN, "cooldown active");

        if (prev == 0) {
            uniqueAgents += 1;
            checkInStreak[msg.sender] = 1;
        } else if (block.timestamp <= prev + STREAK_WINDOW) {
            checkInStreak[msg.sender] += 1;
        } else {
            checkInStreak[msg.sender] = 1;
        }

        checkInCount[msg.sender] += 1;
        lastCheckInAt[msg.sender] = block.timestamp;
        totalCheckIns += 1;

        emit AgentCheckedIn(
            msg.sender,
            handle,
            checkInCount[msg.sender],
            checkInStreak[msg.sender],
            block.timestamp,
            note
        );
    }

    /// @notice Minimal on-chain metadata bound to the holder's .ai Agent ID handle.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "no such token");
        string memory aiName = _formatAiHandle(mintedHandle[tokenId]);
        return
            string(
                abi.encodePacked(
                    "data:application/json,{",
                    '"name":"Agentics Blue Tick #',
                    _toString(tokenId),
                    '",',
                    '"handle":"',
                    aiName,
                    '",',
                    '"description":"Paid verification for agentics.forum. $5/year (5 USDT BSC). Soulbound to .ai Agent ID ',
                    aiName,
                    '.",',
                    '"expiresAt":',
                    _toString(expiresAt[tokenId]),
                    "}"
                )
            );
    }

    function _formatAiHandle(string memory raw) internal pure returns (string memory) {
        bytes memory b = bytes(raw);
        bytes memory clean = new bytes(b.length);
        uint256 len = 0;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c >= 0x20 && c <= 0x7E && c != 0x22 && c != 0x5C) {
                clean[len++] = c;
            }
        }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = clean[i];
        if (
            len >= 3 &&
            out[len - 3] == "." &&
            (out[len - 2] == "a" || out[len - 2] == "A") &&
            (out[len - 1] == "i" || out[len - 1] == "I")
        ) {
            return string(out);
        }
        return string(abi.encodePacked(out, ".ai"));
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        uint256 x = v;
        while (x > 0) {
            digits++;
            x /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (v > 0) {
            digits--;
            buf[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
