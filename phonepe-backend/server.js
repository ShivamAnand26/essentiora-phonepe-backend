const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- PhonePe Configuration from .env ---
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SALT_KEY;
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX;
const PHONEPE_BASE_URL = process.env.PHONEPE_BASE_URL || 'https://api-preprod.phonepe.com/apis/hermes';
const REDIRECT_URL = process.env.REDIRECT_URL || 'http://localhost:3000/payment-callback';
const BASE_URL_FOR_FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5500';

// Google Sheets Configuration
const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_URL || '';
const PORT = process.env.PORT || 3000;

// Store orders in memory and file
let orders = [];
try {
    orders = JSON.parse(fs.readFileSync('orders.json', 'utf8'));
} catch (error) {
    console.warn('⚠️  orders.json not found, initializing empty orders list.');
    orders = [];
}

/**
 * Generates the X-VERIFY checksum for the PhonePe request.
 */
function generateChecksum(base64Payload, endpoint) {
    const string = base64Payload + endpoint + SALT_KEY;
    const sha256 = crypto.createHash('sha256').update(string).digest('hex');
    const checksum = sha256 + '###' + SALT_INDEX;
    
    console.log(`[CHECKSUM] Generated for endpoint: ${endpoint}`);
    return checksum;
}

/**
 * Verify callback checksum for security
 */
function verifyCallbackChecksum(base64Response, xVerifyHeader) {
    try {
        const calculatedChecksum = crypto
            .createHash('sha256')
            .update(base64Response + SALT_KEY)
            .digest('hex');
        
        const receivedChecksum = xVerifyHeader.split('###')[0];
        return calculatedChecksum === receivedChecksum;
    } catch (error) {
        console.error('[CHECKSUM VERIFY ERROR]:', error);
        return false;
    }
}

/**
 * Check payment status with PhonePe API
 */
async function checkPaymentStatus(merchantTransactionId) {
    try {
        const endpoint = `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`;
        const checksumString = endpoint + SALT_KEY;
        const checksum = crypto.createHash('sha256').update(checksumString).digest('hex') + '###' + SALT_INDEX;

        const url = `${PHONEPE_BASE_URL}${endpoint}`;
        
        console.log(`[STATUS CHECK] URL: ${url}`);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': checksum,
                'X-MERCHANT-ID': MERCHANT_ID
            }
        });

        const result = await response.json();
        console.log('[STATUS CHECK RESPONSE]:', JSON.stringify(result, null, 2));
        
        return result;
    } catch (error) {
        console.error('[STATUS CHECK ERROR]:', error);
        throw error;
    }
}

// Create PhonePe Payment
app.post('/create-payment', async (req, res) => {
    try {
        const { orderData } = req.body;

        console.log('[CREATE PAYMENT] Received request:', JSON.stringify(orderData, null, 2));

        // Input Validation
        if (!orderData || !orderData.orderID || !orderData.totalAmount || !orderData.phone || !orderData.name) {
            console.error('[VALIDATION ERROR] Missing mandatory order data:', req.body);
            return res.status(400).json({ 
                success: false, 
                message: 'Missing mandatory order details (orderID, totalAmount, phone, or name).' 
            });
        }
        
        const merchantTransactionId = orderData.orderID;
        const merchantUserId = 'USER_' + orderData.phone;
        const amount = Math.round(parseFloat(orderData.totalAmount) * 100); 

        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid amount value.' 
            });
        }

        const paymentPayload = {
            merchantId: MERCHANT_ID,
            merchantTransactionId,
            merchantUserId,
            amount: amount,
            redirectUrl: `${REDIRECT_URL}?merchantTransactionId=${merchantTransactionId}`,
            redirectMode: 'POST',
            callbackUrl: REDIRECT_URL,
            mobileNumber: orderData.phone,
            paymentInstrument: {
                type: 'PAY_PAGE'
            }
        };

        console.log('[PAYMENT PAYLOAD]:', JSON.stringify(paymentPayload, null, 2));

        // Encode payload
        const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
        
        // Generate checksum with correct endpoint
        const payEndpoint = '/pg/v1/pay';
        const checksum = generateChecksum(base64Payload, payEndpoint);

        // Call PhonePe API
        const url = `${PHONEPE_BASE_URL}${payEndpoint}`;
        
        console.log(`[API CALL] URL: ${url}`);
        console.log(`[API CALL] Merchant ID: ${MERCHANT_ID}`);
        console.log(`[API CALL] X-VERIFY: ${checksum.substring(0, 20)}...###${SALT_INDEX}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': checksum,
                'X-MERCHANT-ID': MERCHANT_ID
            },
            body: JSON.stringify({ request: base64Payload })
        });

        const result = await response.json();
        
        console.log('[PHONEPE RESPONSE]:', JSON.stringify(result, null, 2));

        // Save order with PENDING status
        const fullOrderData = {
            ...orderData,
            status: 'PENDING',
            phonepeResponse: result,
            createdAt: new Date().toISOString()
        };

        orders.push(fullOrderData);
        fs.writeFileSync('orders.json', JSON.stringify(orders, null, 2));

        // Send to Google Sheets
        sendToGoogleSheets(fullOrderData);

        if (result.success && result.data?.instrumentResponse?.redirectInfo?.url) {
            console.log('[SUCCESS] Payment URL generated:', result.data.instrumentResponse.redirectInfo.url);
            res.json({
                success: true,
                paymentUrl: result.data.instrumentResponse.redirectInfo.url,
                merchantTransactionId
            });
        } else {
            console.error('[PHONEPE ERROR]:', result.message, result.code);
            res.json({
                success: false,
                message: result.message || 'Payment creation failed. Check server logs.',
                code: result.code,
                data: result
            });
        }

    } catch (error) {
        console.error('[CREATE PAYMENT ERROR]:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error: ' + error.message 
        });
    }
});

// Payment Callback Handler
app.all('/payment-callback', async (req, res) => {
    try {
        console.log('\n' + '='.repeat(60));
        console.log('[CALLBACK RECEIVED]');
        console.log('='.repeat(60));
        console.log('[METHOD]:', req.method);
        console.log('[HEADERS]:', JSON.stringify(req.headers, null, 2));
        console.log('[BODY]:', JSON.stringify(req.body, null, 2));
        console.log('[QUERY]:', JSON.stringify(req.query, null, 2));
        console.log('='.repeat(60) + '\n');

        const requestData = req.method === 'POST' ? req.body : req.query;
        const base64Response = requestData.response;

        let txnId, paymentStatus, transactionId;

        if (base64Response) {
            // Server-to-server callback with base64 response
            console.log('[CALLBACK TYPE] Server-to-Server (S2S)');
            
            // Verify checksum for security
            const xVerifyHeader = req.headers['x-verify'];
            if (xVerifyHeader && !verifyCallbackChecksum(base64Response, xVerifyHeader)) {
                console.error('[SECURITY ERROR] Invalid checksum in callback');
                return res.status(400).send('<h1>Invalid Checksum</h1>');
            }

            const decodedResponse = JSON.parse(Buffer.from(base64Response, 'base64').toString());
            console.log('[DECODED S2S RESPONSE]:', JSON.stringify(decodedResponse, null, 2));

            txnId = decodedResponse.data?.merchantTransactionId;
            paymentStatus = decodedResponse.code;
            transactionId = decodedResponse.data?.transactionId;

        } else if (requestData.merchantTransactionId || requestData.txnId) {
            // Browser redirect - MUST verify with status API
            console.log('[CALLBACK TYPE] Browser Redirect');
            
            txnId = requestData.merchantTransactionId || requestData.txnId;
            
            // Always verify with status check API for security
            console.log('[STATUS CHECK] Verifying payment status with PhonePe...');
            
            const statusResponse = await checkPaymentStatus(txnId);
            
            if (statusResponse.success) {
                paymentStatus = statusResponse.code;
                transactionId = statusResponse.data?.transactionId;
            } else {
                paymentStatus = 'PAYMENT_ERROR';
                transactionId = 'VERIFICATION_FAILED';
            }
            
        } else {
            console.error('[CALLBACK ERROR] No transaction data received');
            return res.send('<h1>Callback Error: No transaction data received.</h1>');
        }

        // Update order status
        updateOrderStatus(txnId, paymentStatus, transactionId, res, BASE_URL_FOR_FRONTEND);

    } catch (error) {
        console.error('[CALLBACK ERROR]:', error);
        res.status(500).send(`<h1>Callback Error: ${error.message}</h1>`);
    }
});

// Helper function to update order status
function updateOrderStatus(txnId, code, transactionId, res, clientBaseUrl) {
    const orderIndex = orders.findIndex(o => o.orderID === txnId);

    if (orderIndex === -1) {
        console.error(`[ORDER NOT FOUND] ${txnId}`);
        return res.send('<h1>Order Not Found in server records.</h1>');
    }

    const status = code === 'PAYMENT_SUCCESS' ? 'PAID' : 
                   code === 'PAYMENT_PENDING' ? 'PENDING' : 'FAILED';
    
    orders[orderIndex].status = status;
    orders[orderIndex].phonepeTransactionId = transactionId;
    orders[orderIndex].paymentCode = code;
    orders[orderIndex].updatedAt = new Date().toISOString();
    
    const orderDetails = orders[orderIndex];

    fs.writeFileSync('orders.json', JSON.stringify(orders, null, 2));

    // Update Google Sheets
    updateGoogleSheets(orderDetails);

    console.log(`[ORDER UPDATED] ${txnId} -> ${status}`);

    // Send HTML response
    if (status === 'PAID') {
        res.send(generateSuccessPage(txnId, transactionId, orderDetails.totalAmount, orderDetails.name, clientBaseUrl));
    } else if (status === 'PENDING') {
        res.send(generatePendingPage(txnId, clientBaseUrl));
    } else {
        res.send(generateFailurePage(txnId, clientBaseUrl));
    }
}

// --- HTML RESPONSE TEMPLATES ---

function generateSuccessPage(txnId, transactionId, amount, name, clientBaseUrl) {
    return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Successful</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f8ff; margin: 0; }
              .success { color: green; font-size: 28px; margin: 20px 0; }
              .details { background: white; padding: 30px; border-radius: 12px; margin: 20px auto; max-width: 500px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: left; }
              .details p { margin: 10px 0; font-size: 15px; color: #333; }
              .btn { background: #0288d1; color: white; padding: 14px 28px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; margin: 10px; text-decoration: none; display: inline-block; font-weight: 600; }
              .btn:hover { background: #026aa7; }
              .btn-secondary { background: #6c757d; }
              .btn-secondary:hover { background: #545b62; }
            </style>
          </head>
          <body>
            <h1 class="success">✅ Payment Successful!</h1>
            <div class="details">
              <p><strong>Order ID:</strong> ${txnId}</p>
              <p><strong>Transaction ID:</strong> ${transactionId}</p>
              <p><strong>Amount Paid:</strong> ₹${amount || 'N/A'}</p>
              <p><strong>Customer:</strong> ${name || 'N/A'}</p>
            </div>
            <p style="font-size: 16px; color: #666;">Your order has been confirmed! You will receive an email shortly.</p>
            <a href="${clientBaseUrl}/cart.html?payment=success&orderId=${txnId}" class="btn">View Order Details</a>
            <button onclick="window.close()" class="btn btn-secondary">Close Window</button>
          </body>
        </html>
    `;
}

function generatePendingPage(txnId, clientBaseUrl) {
    return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Pending</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #fff9e6; margin: 0; }
              .pending { color: orange; font-size: 28px; margin: 20px 0; }
              .btn { background: #ff9800; color: white; padding: 14px 28px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; margin: 10px; text-decoration: none; display: inline-block; font-weight: 600; }
              .btn-secondary { background: #6c757d; }
            </style>
          </head>
          <body>
            <h1 class="pending">⏳ Payment Pending</h1>
            <p style="font-size: 16px;"><strong>Order ID:</strong> ${txnId || 'N/A'}</p>
            <p style="font-size: 16px; color: #666;">Your payment is being processed. Please check back in a few minutes.</p>
            <a href="${clientBaseUrl}/cart.html" class="btn">Check Status</a>
            <button onclick="window.close()" class="btn btn-secondary">Close Window</button>
          </body>
        </html>
    `;
}

function generateFailurePage(txnId, clientBaseUrl) {
    return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Failed</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #fff5f5; margin: 0; }
              .error { color: red; font-size: 28px; margin: 20px 0; }
              .btn { background: #dc3545; color: white; padding: 14px 28px; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; margin: 10px; text-decoration: none; display: inline-block; font-weight: 600; }
              .btn:hover { background: #c82333; }
              .btn-secondary { background: #6c757d; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Payment Failed</h1>
            <p style="font-size: 16px;"><strong>Order ID:</strong> ${txnId || 'N/A'}</p>
            <p style="font-size: 16px; color: #666;">Please try again or contact support.</p>
            <a href="${clientBaseUrl}/cart.html" class="btn">Return to Cart</a>
            <button onclick="window.close()" class="btn btn-secondary">Close Window</button>
          </body>
        </html>
    `;
}

// Check Payment Status API
app.get('/check-payment/:orderId', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const order = orders.find(o => o.orderID === orderId);
        
        if (!order) {
            return res.json({ success: false, message: 'Order not found' });
        }

        // If status is pending, check with PhonePe
        if (order.status === 'PENDING') {
            console.log(`[CHECK STATUS] Verifying pending order: ${orderId}`);
            
            const statusResponse = await checkPaymentStatus(orderId);
            
            if (statusResponse.success) {
                const newStatus = statusResponse.code === 'PAYMENT_SUCCESS' ? 'PAID' : 
                                 statusResponse.code === 'PAYMENT_PENDING' ? 'PENDING' : 'FAILED';
                
                order.status = newStatus;
                order.phonepeTransactionId = statusResponse.data?.transactionId;
                order.paymentCode = statusResponse.code;
                order.updatedAt = new Date().toISOString();
                
                fs.writeFileSync('orders.json', JSON.stringify(orders, null, 2));
                updateGoogleSheets(order);
            }
        }

        res.json({ success: true, status: order.status, order });
    } catch (error) {
        console.error('[CHECK PAYMENT ERROR]:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get All Orders Dashboard
app.get('/orders', (req, res) => {
    const ordersHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Orders Dashboard</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            h1 { color: #1a1a1a; }
            table { width: 100%; border-collapse: collapse; margin: 20px 0; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
            th { background-color: #0288d1; color: white; font-weight: 600; }
            .paid { color: green; font-weight: bold; }
            .pending { color: orange; font-weight: bold; }
            .failed { color: red; font-weight: bold; }
            .refresh-btn { background: #0288d1; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin: 10px 0; font-weight: 600; }
            .refresh-btn:hover { background: #026aa7; }
          </style>
        </head>
        <body>
          <h1>📊 Orders Dashboard</h1>
          <p><strong>Total Orders:</strong> ${orders.length}</p>
          <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
          <table>
            <tr>
              <th>Order ID</th>
              <th>Customer</th>
              <th>Phone</th>
              <th>Amount</th>
              <th>Payment Method</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
            ${orders.slice().reverse().map(order => `
              <tr>
                <td>${order.orderID || 'N/A'}</td>
                <td>${order.name || 'N/A'}</td>
                <td>${order.phone || 'N/A'}</td>
                <td>₹${order.totalAmount || 'N/A'}</td>
                <td>${order.paymentMethod || 'PhonePe'}</td>
                <td class="${order.status ? order.status.toLowerCase() : 'pending'}">${order.status || 'PENDING'}</td>
                <td>${order.createdAt ? new Date(order.createdAt).toLocaleString() : 'N/A'}</td>
              </tr>
            `).join('')}
          </table>
        </body>
        </html>
    `;
    res.send(ordersHtml);
});

// Helper: Send to Google Sheets
function sendToGoogleSheets(orderData) {
    if (!GOOGLE_SHEETS_URL || GOOGLE_SHEETS_URL.includes('YOUR_DEPLOYMENT_ID')) {
        console.log('[GOOGLE SHEETS] Placeholder URL, skipping.');
        return;
    }
    
    fetch(GOOGLE_SHEETS_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData)
    }).catch(err => console.error('[GOOGLE SHEETS ERROR]:', err));
}

function updateGoogleSheets(orderData) {
    if (!GOOGLE_SHEETS_URL || GOOGLE_SHEETS_URL.includes('YOUR_DEPLOYMENT_ID')) {
        return;
    }
    
    const updateData = {
        action: 'update',
        orderId: orderData.orderID,
        status: orderData.status,
        paymentId: orderData.phonepeTransactionId || '',
        updatedAt: new Date().toLocaleString()
    };
    
    fetch(GOOGLE_SHEETS_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
    }).catch(err => console.error('[GOOGLE SHEETS UPDATE ERROR]:', err));
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        config: {
            merchantId: MERCHANT_ID,
            saltIndex: SALT_INDEX,
            baseUrl: PHONEPE_BASE_URL,
            environment: PHONEPE_BASE_URL.includes('preprod') ? 'UAT/Testing' : 'Production'
        }
    });
});

// Start Server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(70));
    console.log('🚀 PhonePe Payment Server - RUNNING');
    console.log('='.repeat(70));
    console.log(`📡 Server URL:        http://localhost:${PORT}`);
    console.log(`📊 Orders Dashboard:  http://localhost:${PORT}/orders`);
    console.log(`🏥 Health Check:      http://localhost:${PORT}/health`);
    console.log('='.repeat(70));
    console.log('💳 PhonePe Configuration:');
    console.log(`   Merchant ID:       ${MERCHANT_ID}`);
    console.log(`   Salt Index:        ${SALT_INDEX}`);
    console.log(`   Base URL:          ${PHONEPE_BASE_URL}`);
    console.log(`   Environment:       ${PHONEPE_BASE_URL.includes('preprod') ? '🧪 UAT/Testing' : '🏭 Production'}`);
    console.log('='.repeat(70));
    console.log('⚠️  IMPORTANT REMINDERS:');
    console.log('   ✅ Using updated test credentials (PGTESTPAYUAT86)');
    console.log('   ✅ Download PhonePe Simulator App for testing');
    console.log('   ⚠️  Use HTTPS callback URL in production');
    console.log('   📱 For local testing with callback, use ngrok');
    console.log('='.repeat(70) + '\n');
});