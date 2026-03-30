# Telegram Trading Bot

A Telegram-based trading bot built with Node.js and ethers.js for executing on-chain transactions through a simple and responsive interface.

## Overview
This project is a trading automation system built with Node.js and ethers.js. It interacts with blockchain networks through an RPC provider to execute transactions in real time.

It focuses on speed, simplicity, and manual control, allowing users to interact with the system through commands while handling real-time transaction processing.

---
## Key Features
- Command-based trade execution
- Real-time transaction handling
- API and RPC integration
- Configurable transaction parameters
---
## Technologies Used
- Node.js
- ethers.js
- JSON
- APIs
- RPC
---
## What I Learned
- Working with APIs and RPC providers
- Handling asynchronous operations
- Designing command-based systems
- Managing real-time data flows
---
## How It Works

This bot runs through a command-driven interface inside Telegram. Users interact with it by sending commands or pasting contract addresses, and the system handles the rest in real time.

When a user submits input, the bot processes it and pulls relevant token data such as symbol and decimals. Based on that, it prepares the transaction details needed to execute a trade.

Transactions are built and sent using ethers.js through a configured RPC provider. Once submitted, the bot tracks the transaction and returns feedback to the user, including status updates, balances, and confirmations.

Basic state and position data are also tracked so users can see their holdings and understand performance over time.

---

## Notes
This project demonstrates practical experience working with asynchronous JavaScript, API integration, and blockchain transaction handling.
This project is intended for learning and demonstration purposes. Sensitive data such as private keys and API credentials are not included in this repository.

