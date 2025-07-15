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
app.use(cors({
    origin: "https://automated-printing.onrender.com/",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));
// Create a Map to track timeouts for each request
const requestTimeouts = new Map();
let printingprices={};
let queueNumber;
let merchantIp = "";
let printerCapabilities = {};
let fallbackQueueCounter = 0;
let merchantPrinters;
app.use(express.json());

const port = process.env.PORT || 6822;
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
// const UPI_ID = "8999617312@ybl";  // Replace with your UPI ID
let merchantDetails = { shopName: "", upiId: "" };


let merchantSocket = null;
let printQueue = [];  // This will store the print requests with their queue numbers
let printerList = []; // Store latest printer list
cleanUploadsDirectory();

app.get("/index.html", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});
 // In server.js or wherever your Express app is
app.post("/print-status", (req, res) => {
    const { queueNumber, status} = req.body;
    socketId = req.body.socketId;
    console.log(req.body);
    
    if (status === "printCompleted") {
        const request = printQueue.find(req => req.queueNumber === queueNumber);
        
        if (request && socketId) {
            io.to(socketId).emit("printCompleted", { queueNumber ,socketId});
            console.log(`✅ Print completed for queue #${queueNumber}`);
          console.log(`✅ Notified user ${request.socketId} about completion of queue #${queueNumber}`);
      } else {
          console.warn(`⚠️ Could not find socketId for queue #${queueNumber}`);
      }
        removePrintRequest(queueNumber);
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
    socket.on("updatePrintRequest", ({ queueNumber, printerSettings }) => {
    const request = printQueue.find(req => req.queueNumber === queueNumber);
    if (request) {
        // Update the settings
        request.printerSettings = printerSettings;
        
        // Recalculate cost (optional)
        // You might want to implement cost recalculation here
        
        io.emit("updateQueue", printQueue);
    }
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
// socket.on("confirmPayment", (queueNumber) => {
//     const request = printQueue.find(req => req.queueNumber === queueNumber);
//     if (request) {
//         request.paymentConfirmed = true;
//         io.emit("updateQueue", printQueue);
//     }
// });

socket.on("confirmPayment", (queueNumber) => {
    // comfirm and print
        io.emit("comfirm_and_print", queueNumber);
});
// Remove request after printing
socket.on("removeRequest", (queueNumber) => {
    printQueue = printQueue.filter(req => req.queueNumber !== queueNumber);
    removePrintRequest(queueNumber);

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
    try {

    if (!req.files || req.files.length === 0) return res.status(400).send("No files uploaded.");
    if (!merchantDetails.upiId) return res.status(400).send("Merchant UPI ID not set.");

    queueNumber = await getNextQueueNumber();
    const perPageCost = { color: printingprices._colorPrice, grayscale: printingprices._blackPrice };
    const colorMode = req.body.colorMode;
    const copies = parseInt(req.body.copies) || 1;
    const pagesStr = req.body.pages;
    const socketId = req.headers["x-socket-id"];
    const subset  = req.body.subset;         // "odd" | "even" | undefined
    const side    = req.body.side || "simplex";  // duplex modes or simplex
    const isDuplex = side !== "simplex";
    let totalCost = 0;
    let uploadedFiles = [];
    // function countPages(pagesStr) {
    //     if (!pagesStr) return null;
    //     const ranges = pagesStr.split(',');
    //     let count = 0;
    //     for (const range of ranges) {
    //         if (range.includes('-')) {
    //             const [start, end] = range.split('-').map(Number);
    //             if (!isNaN(start) && !isNaN(end)) count += end - start + 1;
    //         } else {
    //             if (!isNaN(Number(range))) count += 1;
    //         }
    //     }
        
    //     return count;
    // }
  function countPages(str, subset, duplex) {
    if (!str) return null;  // caller will fallback to full-PDF logic

    // 1) Expand ranges into array of numbers
    const nums = [];
    for (let token of str.split(",")) {
      token = token.trim();
      const [a, b] = token.split("-").map(s => Number(s.trim()));
      if (b !== undefined && !isNaN(a) && !isNaN(b) && b >= a) {
        for (let n = a; n <= b; n++) nums.push(n);
      } else if (!isNaN(a)) {
        nums.push(a);
      }
    }

    // 2) Apply odd/even subset
    let filtered = nums;
    if (subset === "odd") {
      filtered = nums.filter(n => n % 2 === 1);
    } else if (subset === "even") {
      filtered = nums.filter(n => n % 2 === 0);
    }

    // 3) Return pages (simplex) or sheets (duplex)
    const pageCount = filtered.length;
    return duplex ? Math.ceil(pageCount / 2) : pageCount;
  }
    // for (const file of req.files) {
    //     const filePath = path.join(__dirname, "uploads", file.filename);
    //     console.log(`Uploading file: ${file.originalname}`);

    //     const fileBuffer = fs.readFileSync(filePath);
    //     let pageCount = 1; // default for non-PDFs
    //     if (file.mimetype === "application/pdf") {
    //         try {
    //             const pdfData = await pdfParse(fileBuffer);
    //             const totalPdfPages = pdfData.numpages;

    //             // If user specified specific pages, count them, else use total
    //             const customPageCount = countPages(pagesStr);
                
    //             pageCount = customPageCount || totalPdfPages;
    //         } catch (err) {
    //             console.error("Error reading PDF:", err);
    //         }
    //     }

    //     const cost = pageCount * copies * perPageCost[colorMode];
    //     totalCost += cost;

    //     uploadedFiles.push({
    //         filePath: `https://automated-printing.onrender.com/uploads/${file.filename}`,
    //         originalName: file.originalname
    //     });
    // }
    
  for (const file of req.files) {
    const filePath = path.join(__dirname, "uploads", file.filename);
    console.log(`Uploading file: ${file.originalname}`);

    const buffer = fs.readFileSync(filePath);
    let pageCount = 1;  // default for non-PDFs

    if (file.mimetype === "application/pdf") {
      try {
        const { numpages } = await pdfParse(buffer);
        let cnt = countPages(pagesStr, subset, isDuplex);

        if (cnt === null) {
          // no range → use all pages (and apply duplex if needed)
          cnt = isDuplex
            ? Math.ceil(numpages / 2)
            : numpages;
        }
        pageCount = cnt;
      } catch (err) {
        console.error("Error reading PDF:", err);
      }
    }

    const cost = pageCount * copies * perPageCost[colorMode];
    totalCost += cost;

    uploadedFiles.push({
      filePath: `https://automated-printing.onrender.com/uploads/${file.filename}`,
      originalName: file.originalname,
    });
  }    
    const upiUrl = `upi://pay?pa=${merchantDetails.upiId}&pn=${merchantDetails.shopName}&mc=0000&tid=123456&tr=TXN${Date.now()}&tn=PrintPayment&am=${totalCost}&cu=INR`;
    const qrCode = await QRCode.toDataURL(upiUrl);

    const newRequest = {
        queueNumber,
        files: uploadedFiles,
        socketId,
        printerSettings: {
            printer:     req.body.printer,
            colorMode:   colorMode,
            copies:      req.body.copies,
            pages:       pagesStr,
            subset:      subset, 
            orientation: req.body.orientation || "portrait",
            scale:       req.body.scale       || "noscale",
            side:        side,
            paperSize:   req.body.paperSize   || "A4",
        },
        totalCost,
        paymentConfirmed: false,
        upiQrCode: qrCode,
        upiUrl  

    };
    
    printQueue.push(newRequest);
    io.emit("updateQueue", printQueue);  // Send updated queue to merchant UI
        const timeoutId = setTimeout(() => {
            if (printQueue.some(req => req.queueNumber === newRequest.queueNumber)) {
                console.log(`⌛ Request ${newRequest.queueNumber} expired after 8 minutes`);
                removePrintRequest(newRequest.queueNumber);
            }
        }, 8 * 60 * 1000); // 8 minutes

        requestTimeouts.set(newRequest.queueNumber, timeoutId);

    res.json({ success: true, request: newRequest });
        } catch (error) {
        console.error("Upload error:", error);
        // Cleanup any uploaded files on error
        req.files?.forEach(file => {
            const filePath = path.join(__dirname, "uploads", file.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        });
        res.status(500).json({ error: "Processing failed" });
    }
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.post("/update-printer", (req, res) => {
    const { printers,printerconfigs,printing_prices } = req.body;
    printingprices = printing_prices;
    // merchantPrinters = printers;
    merchantPrinters = printerconfigs.map(config => config.name);
    console.log(merchantPrinters);
    
    printerCapabilities = {};//clearing
    printerconfigs.forEach(config => {
    printerCapabilities[config.name] = {
            color: config.color,
            duplex: config.duplex
        };
    });
    res.json({ success: true });

    // if (Array.isArray(printers)) {
    //     merchantPrinters = printers;
    //     console.log("Updated merchant printers:", merchantPrinters);
    //     res.json({ success: true });
    // } else {
    //     res.status(400).json({ error: "Invalid printer data" });
    // }
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
    }
});
 
 app.get("/get-printer-capabilities", (req, res) => {
    res.json(printerCapabilities);
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
// function queueNumberincrese( ) {
//     queueNumber +=1
// }
async function getNextQueueNumber() {
  try {
    const response = await axios.get('http://localhost:3001/next-queue');
    return response.data;
  } catch (err) {
    console.error('Error getting queue number from app:', err);
    fallbackQueueCounter++;
    return fallbackQueueCounter;
  }
}
function deleteRequestFiles(request) {
    request.files.forEach(file => {
        const filename = file.filePath.split('/').pop();
        const filePath = path.join(__dirname, 'uploads', filename);
        
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, err => {
                if (err) {
                    console.error(`❌ Error deleting file ${filename}:`, err);
                } else {
                    console.log(`♻️ Deleted file: ${filename}`);
                }
            });
        }
    });
}
function removePrintRequest(queueNumber) {
    const index = printQueue.findIndex(req => req.queueNumber === queueNumber);
    if (index === -1) return;

    const request = printQueue[index];
    
    // Delete associated files
    deleteRequestFiles(request);
    
    // Clear any existing timeout
    if (requestTimeouts.has(queueNumber)) {
        clearTimeout(requestTimeouts.get(queueNumber));
        requestTimeouts.delete(queueNumber);
    }

    printQueue.splice(index, 1);
    io.emit("updateQueue", printQueue);
}
// Add startup cleanup for orphaned files
function cleanUploadsDirectory() {
    const uploadDir = path.join(__dirname, 'uploads');
    fs.readdir(uploadDir, (err, files) => {
        if (err) return console.error('Cleanup error:', err);
        
        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stat = fs.statSync(filePath);
            
            // Delete files older than 8 minutes
            if (Date.now() - stat.mtimeMs > 8 * 60 * 1000) {
                fs.unlink(filePath, err => {
                    if (err) console.error(`Error cleaning ${file}:`, err);
                    else console.log(`♻️ Cleaned old file: ${file}`);
                });
            }
        });
    });
}