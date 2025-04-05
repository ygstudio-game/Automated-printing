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
 
io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.on("printCompleted", (queueNumber) => {
        printQueue = printQueue.filter(req => req.queueNumber !== queueNumber);
        io.emit("updateQueue", printQueue); // Update all connected clients
        console.log(`✅ Queue ${queueNumber} removed after printing.`);
    });
    socket.on("registerMerchant", () => {
        merchantSocket = socket;
        console.log("Merchant registered:", socket.id);
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
 


// Handle the actual print request
// app.post("/print", (req, res) => {
//     const { queueNumber } = req.body;
//     const request = printQueue.find(req => req.queueNumber === queueNumber);

//     if (!request) {
//         return res.status(400).json({ error: "Print request not found" });
//     }

//     const { files, printerSettings } = request;
//     const { printer, colorMode, copies } = printerSettings;
//     const isMonochrome = colorMode === "grayscale"; 

//     const printPromises = files.map(file => {
//         const filePathLocal = path.join(__dirname, "uploads", path.basename(file.filePath));

//         if (!fs.existsSync(filePathLocal)) {
//             return Promise.reject(new Error(`File not found: ${filePathLocal}`));
//         }

//         return pdfToPrinter.print(filePathLocal, {
//             printer: printer,
//             monochrome: isMonochrome,
//             copies: parseInt(copies),
//         });
//     });

//     Promise.all(printPromises)
//         .then(() => {
//             printQueue = printQueue.filter(req => req.queueNumber !== queueNumber);
//             io.emit("printingStarted", queueNumber);
//             io.emit("updateQueue", printQueue); // Update UI after printing
//             res.json({ success: true });

//         })
//         .catch(err => {
//             res.status(500).json({ error: err.message });
//         });
// });



app.post("/print", (req, res) => {
    const { queueNumber } = req.body;
    const request = printQueue.find(req => req.queueNumber === queueNumber);

    if (!request) {
        return res.status(400).json({ error: "Print request not found" });
    }

    // Just update the queue state; actual printing happens on merchant's end
    io.emit("printInitiated", queueNumber);
    res.json({ success: true, message: "Print trigger sent to merchant page" });
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