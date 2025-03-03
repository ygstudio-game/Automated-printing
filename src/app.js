const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const pdfToPrinter = require("pdf-to-printer");
const pdfParse = require("pdf-parse");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
let queueNumber=0;

app.use(cors());
app.use(express.json());

const port = process.env.PORT || 6822;
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const UPI_ID = "8999617312@ybl";  // Replace with your UPI ID

let merchantSocket = null;
let printQueue = [];  // This will store the print requests with their queue numbers

app.get("/index.html", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

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
 
    socket.on("confirmPayment", () => {
        if (merchantSocket) {
            merchantSocket.emit("paymentConfirmed");
        }
    });

    socket.on("disconnect", () => {
        if (socket === merchantSocket) merchantSocket = null;
    });
});

// Generate UPI QR for payment
app.get("/generateQR", async (req, res) => {
    const clientUrl = `http://localhost:${port}/index.html?mode=client`;
    try {
        const qrCode = await QRCode.toDataURL(clientUrl);
        res.json({ qrCode });
    } catch (err) {
        res.status(500).send("Error generating QR code");
    }
});
 // Upload files and process the print cost and UPI QR generation
app.post("/upload", upload.array("files"), async (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send("No files uploaded.");
          // Add the print request to the queue with a unique queue number
        queueNumberincrese();
    const perPageCost = { color: 5, grayscale: 2 };
    const colorMode = req.body.colorMode;
    const copies = parseInt(req.body.copies) || 1;

    let totalCost = 0;
    let uploadedFiles = [];

    for (const file of req.files) {
        const filePath = path.join(__dirname, "uploads", file.filename);

        console.log(`Uploading file: ${file.originalname} (MIME: ${file.mimetype})`);

        const fileBuffer = fs.readFileSync(filePath);
        let pages = 0;

        if (file.mimetype === "application/pdf") {
            try {
                const pdfData = await pdfParse(fileBuffer);
                pages = pdfData.numpages;
                console.log(`PDF file ${file.originalname} has ${pages} pages.`);
            } catch (err) {
                console.error("Error reading PDF file:", err);
                pages = 1;  // Default to 1 if there's an error
            }
        } else {
            pages = 1;  // Default to 1 page for non-PDF files (e.g., images)
        }

        const cost = pages * copies * perPageCost[colorMode];
        totalCost += cost;

        console.log(`Pages: ${pages}, Copies: ${copies}, Cost per Page: ${perPageCost[colorMode]}, Total Cost: ₹${totalCost}`);

        uploadedFiles.push({
            filePath: `http://localhost:${port}/uploads/${file.filename}`,
            originalName: file.originalname
        });
    }

    const upiUrl = `upi://pay?pa=${UPI_ID}&pn=Merchant&mc=0000&tid=123456&tr=TXN${Date.now()}&tn=PrintPayment&am=${totalCost}&cu=INR`;
    const qrCode = await QRCode.toDataURL(upiUrl);

    const fileData = {
        files: uploadedFiles,
        printerSettings: {
            printer: req.body.printer,
            colorMode: req.body.colorMode,
            copies: req.body.copies,
        },
        totalCost,
        queueNumber,
        upiQrCode: qrCode
    };
    
    io.emit("printFile", fileData);
    res.json({ success: true, files: fileData });
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Handle the actual print request
app.post("/print", (req, res) => {
    const { files, printer, colorMode, copies } = req.body;

    if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files provided for printing" });
    }

    const isMonochrome = colorMode === "grayscale"; 

    const printPromises = files.map(file => {
        const filePathLocal = path.join(__dirname, "uploads", path.basename(file.filePath));

        if (!fs.existsSync(filePathLocal)) {
            return Promise.reject(new Error(`File not found: ${filePathLocal}`));
        }

        return pdfToPrinter.print(filePathLocal, {
            printer: printer,
            monochrome: isMonochrome,
            copies: parseInt(copies),
        });
    });

    Promise.all(printPromises)
        .then(() => {
            res.json({ success: true });
        })
        .catch(err => {
            res.status(500).json({ error: err.message });
        });
});

server.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}/`);
});
function queueNumberincrese( ) {
    queueNumber +=1
}