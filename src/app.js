const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const multer = require("multer");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const pdfToPrinter = require("pdf-to-printer");
const pdfParse = require("pdf-parse");
const { log } = require("console");
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const axios = require("axios"); // Ensure axios is required
const cors = require("cors");

// Allow only your deployed frontend
app.use(cors({
    origin: "https://automated-printing.onrender.com",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

let queueNumber=0;
let merchantIp = "";

app.use(express.json());

const port = process.env.PORT || 6822;
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
// const UPI_ID = "8999617312@ybl";  // Replace with your UPI ID
let merchantDetails = { shopName: "", upiId: "" };


let merchantSocket = null;
let printQueue = [];  // This will store the print requests with their queue numbers
let printerList = []; // Store latest printer list

app.get("/index.html", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});
 // In server.js or wherever your Express app is
app.post("/print-status", (req, res) => {
    const { queueNumber, status,socketId} = req.body;
    console.log(socketId)
    if (status === "printCompleted") {
        const request = printQueue.find(req => req.queueNumber === queueNumber);
        
        if (request && socketId) {
            io.to(socketId).emit("printCompleted", { queueNumber },{socketId});
            console.log(`✅ Print completed for queue #${queueNumber}`);
          console.log(`✅ Notified user ${request.socketId} about completion of queue #${queueNumber}`);
      } else {
          console.warn(`⚠️ Could not find socketId for queue #${queueNumber}`);
      }
          }
  
    res.sendStatus(200);
  });
  
io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.on("printCompleted", (queueNumber,socketId) => {
        console.log(socketId)
        printQueue = printQueue.filter(req => req.queueNumber !== queueNumber);
        io.emit("updateQueue", printQueue); // Update all connected clients
    io.emit("printingStarted", queueNumber,socketId);
    console.log(`✅ Queue ${queueNumber} removed after printing.`);
    });
    socket.on("registerMerchant", () => {
        merchantSocket = socket;
        console.log("Merchant registered:", socket.id);
        io.emit("updateQueue", printQueue); // Update all connected clients
    });

    socket.on("getPrinters", () => {
        pdfToPrinter.getPrinters()
            .then(printers => {
                socket.emit("printerInfo", printers);
            })
            .catch(err => {
                console.error("Error fetching printers:", err);
                socket.emit("printerInfo", []);
            });
    });
// Confirm payment for a specific request
socket.on("confirmPayment", (queueNumber) => {
    const request = printQueue.find(req => req.queueNumber === queueNumber);
    if (request) {
        request.paymentConfirmed = true;
        io.emit("updateQueue", printQueue);
    }
});
// Remove request after printing
socket.on("removeRequest", (queueNumber) => {
    printQueue = printQueue.filter(req => req.queueNumber !== queueNumber);
    io.emit("updateQueue", printQueue);
});

    socket.on("disconnect", () => {
        if (socket === merchantSocket) merchantSocket = null;
    });

    
});
app.post("/saveMerchant", (req, res) => {
    const { shopName, upiId } = req.body;
    
    if (!shopName || !upiId) {
        return res.status(400).json({ success: false, message: "Missing shop name or UPI ID" });
    }

    merchantDetails.shopName = shopName;
    merchantDetails.upiId = upiId;

    res.json({ success: true, message: "Merchant details saved" });
});
 
// Generate UPI QR for payment
app.get("/generateQR", async (req, res) => {
    const clientUrl = `https://automated-printing.onrender.com/index.html?mode=client`;
    try {
        const qrCode = await QRCode.toDataURL(clientUrl);
        res.json({ qrCode });
    } catch (err) {
        res.status(500).send("Error generating QR code");
    }
});
app.post("/upload", upload.array("files"), async (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send("No files uploaded.");
    if (!merchantDetails.upiId) return res.status(400).send("Merchant UPI ID not set.");

    queueNumber++;  // Assign a unique queue number
    const perPageCost = { color: 5, grayscale: 2 };
    const colorMode = req.body.colorMode;
    const copies = parseInt(req.body.copies) || 1;
    const socketId = req.headers["x-socket-id"];

    let totalCost = 0;
    let uploadedFiles = [];

    for (const file of req.files) {
        const filePath = path.join(__dirname, "uploads", file.filename);
        console.log(`Uploading file: ${file.originalname}`);

        const fileBuffer = fs.readFileSync(filePath);
        let pages = 1;

        if (file.mimetype === "application/pdf") {
            try {
                const pdfData = await pdfParse(fileBuffer);
                pages = pdfData.numpages;
            } catch (err) {
                console.error("Error reading PDF:", err);
            }
        }

        const cost = pages * copies * perPageCost[colorMode];
        totalCost += cost;

        uploadedFiles.push({
            filePath: `https://automated-printing.onrender.com/uploads/${file.filename}`,
            originalName: file.originalname
        });
    }
        
    const upiUrl = `upi://pay?pa=${merchantDetails.upiId}&pn=${merchantDetails.shopName}&mc=0000&tid=123456&tr=TXN${Date.now()}&tn=PrintPayment&am=${totalCost}&cu=INR`;
    const qrCode = await QRCode.toDataURL(upiUrl);

    const newRequest = {
        queueNumber,
        files: uploadedFiles,
        socketId,
        printerSettings: {
            printer: req.body.printer,
            colorMode: req.body.colorMode,
            copies: req.body.copies,
        },
        totalCost,
        paymentConfirmed: false,
        upiQrCode: qrCode,
        upiUrl // Add the UPI URL for redirection

    };
    
    printQueue.push(newRequest);
    io.emit("updateQueue", printQueue);  // Send updated queue to merchant UI

    res.json({ success: true, request: newRequest });
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.post("/update-printer", (req, res) => {
    const { printers } = req.body;
    if (Array.isArray(printers)) {
        merchantPrinters = printers;
        console.log("Updated merchant printers:", merchantPrinters);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: "Invalid printer data" });
    }
});
app.get("/previous-requests", (req, res) => {
    res.json(printQueue);
});

app.get("/get-printer", async (req, res) => {
    try {
        // const response = await axios.get("http://localhost:3001/printers");
        // res.json(response.data); // Use live data
        res.json({ printers: merchantPrinters }); // Fallback to stored list
    } catch (error) {
        console.error("Error fetching printers from Electron app:", error.message);
        res.json({ printers: merchantPrinters }); // Fallback to stored list
    }
});
 
 

app.post("/print", (req, res) => {
    const { queueNumber } = req.body;
    const request = printQueue.find(req => req.queueNumber === queueNumber);

    if (!request) {
        return res.status(400).json({ error: "Print request not found" });
    }

    // Emit to merchant via Socket.IO
    io.emit("startPrint", request);

    console.log("📤 Sent print request via socket to merchant:", queueNumber);
    res.json({ success: true, message: "Print request sent to merchant" });
});

  
app.get("/get-request", (req, res) => {
    const queueNumber = req.query.queueNumber;
    const request = printQueue.find(req => req.queueNumber == queueNumber); // use == for string/number match

    if (!request) {
        return res.status(404).json({ error: "Request not found" });
    }

    res.json(request);
});


app.get("/get-file", (req, res) => {
    const { filename } = req.query;

    if (!filename) {
        return res.status(400).json({ error: "Filename query parameter is required" });
    }

    const filePath = path.join(__dirname, "uploads", filename);

    if (fs.existsSync(filePath)) {
        return res.json({ exists: true, path: filePath });
    } else {
        return res.status(404).json({ exists: false, message: "File not found" });
    }
});

server.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}/`);
});
function queueNumberincrese( ) {
    queueNumber +=1
}