# Automated Printing Service (Server)

This is the server component for the Automated Printing Service, which handles client requests, file uploads, payment processing, and communication with the merchant's Electron application.

## Features
- File upload and storage
- Print queue management
- UPI payment integration with QR generation
- Real-time communication via Socket.IO
- Automatic file cleanup system
- Printer capability management
- Cost calculation based on print settings

## Technologies
- Node.js
- Express
- Socket.IO
- Multer (file uploads)
- QRCode (UPI QR generation)
- pdf-parse (PDF processing)
- Axios (HTTP requests)

## Setup Instructions

1. **Clone the repository:**
```bash
git clone https://github.com/ygstudio-game/automated-printing-server.git
cd automated-printing