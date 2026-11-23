// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockRegistry {
    mapping(address => string) public handleOf;
    mapping(address => uint256) public balanceOf;
    function setHandle(address who, string calldata h) external {
        handleOf[who] = h;
        balanceOf[who] = bytes(h).length > 0 ? 1 : 0;
    }
}
