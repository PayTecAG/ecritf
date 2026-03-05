# KIT JSON Electron - PayTec Terminal Interface

A cross-platform GUI application demonstrating integration with PayTec EFT/POS terminals using the ECR Interface (NDJSON over TCP).

## Features

- Connect to payment terminal via TCP
- Open/close shifts (activation/deactivation)
- Execute transactions (purchase, credit, reversal)
- Automatic heartbeat handling
- Receipt display
- JSON Schema validation of all messages
- Real-time message log

## Requirements

- Node.js 18+ 
- npm

## Installation

```bash
cd examples/node/kit-json-electron
npm install
```

## Running

```bash
npm start
```

## Building Executables

For Windows installer:
```bash
npm run dist
```

For Linux AppImage:
```bash
npm run dist
```

Executables will be in the `dist/` folder.

## Usage

1. Enter the terminal IP address (default: 127.0.0.1)
2. Enter the port (default: 8307)
3. Click **Connect**
4. Click **Activate** to open a shift
5. Enter an amount and click **Purchase** to start a transaction
6. After approval, click **Confirm** or **Rollback**
7. Click **Deactivate** to close the shift

## Keyboard Shortcuts

- `Ctrl+Enter` - Start purchase transaction
- `Ctrl+Backspace` - Abort current transaction

## Message Flow

```
ECR                                   Terminal
 |                                       |
 |--- ConnectRequest ------------------->|
 |<-- ConnectResponse -------------------|
 |                                       |
 |--- ActivationRequest ---------------->|
 |<-- ActivationResponse ----------------|
 |                                       |
 |--- TransactionRequest --------------->|
 |<-- StatusResponse --------------------| (multiple)
 |<-- TransactionResponse ---------------|
 |                                       |
 |--- TransactionConfirmationRequest --->|
 |<-- TransactionConfirmationResponse ---|
 |<-- ReceiptResponse -------------------|
 |                                       |
 |<-- HeartbeatRequest ------------------| (every ~10s)
 |--- HeartbeatResponse ---------------->|
 |                                       |
 |<-- StatusResponse --------------------| (may arrive any time)
 
```

## Schema

All messages are validated against `../../../ecritf-schema.json` (JSON Schema Draft 2020-12).

## License

MIT
