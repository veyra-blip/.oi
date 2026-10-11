const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadDb() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Register
app.post('/api/register', (req, res) => {
    const { firstname, lastname, phone, email, password, pin } = req.body;
    const db = loadDb();

    if (db.users[phone]) {
        return res.status(400).json({ success: false, message: 'Account with this phone number already exists.' });
    }

    const accountNumber = '81' + Math.floor(10000000 + Math.random() * 90000000);

    db.users[phone] = {
        firstname,
        lastname,
        phone,
        email,
        password,
        pin,
        accountNumber,
        balance: 500000000,
        hideBalance: false,
        transactions: [],
        notifications: [{
            title: 'Welcome to OPay Demo',
            message: 'Your account has been credited with your ₦500,000,000 starting virtual balance.',
            date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            read: false
        }]
    };

    saveDb(db);
    res.json({ success: true, phone });
});

// Login
app.post('/api/login', (req, res) => {
    const { identifier, password } = req.body;
    const db = loadDb();
    let foundPhone = null;

    for (let phone in db.users) {
        let u = db.users[phone];
        if (u.phone === identifier || u.email === identifier) {
            if (u.password === password) {
                foundPhone = phone;
                break;
            }
        }
    }

    if (!foundPhone) return res.status(400).json({ success: false, message: 'Invalid phone/email or password.' });
    res.json({ success: true, phone: foundPhone });
});

// Get User
app.get('/api/user/:phone', (req, res) => {
    const db = loadDb();
    const user = db.users[req.params.phone];
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, user });
});

// Internal Transfer (Phone or Account Number only)
app.post('/api/transfer', (req, res) => {
    const { senderPhone, recipientTarget, amount, pin } = req.body;
    const db = loadDb();
    const sender = db.users[senderPhone];

    if (!sender) return res.status(404).json({ success: false, message: 'Sender not found.' });
    if (pin !== sender.pin) return res.status(400).json({ success: false, message: 'Incorrect Transaction PIN.' });
    if (amount <= 0 || amount > sender.balance) return res.status(400).json({ success: false, message: 'Insufficient balance or invalid amount.' });

    let recipientPhone = null;
    for (let p in db.users) {
        let u = db.users[p];
        if (u.phone === recipientTarget || u.accountNumber === recipientTarget) {
            recipientPhone = p;
            break;
        }
    }

    if (!recipientPhone) return res.status(400).json({ success: false, message: 'Recipient account or phone number not found in network.' });
    if (recipientPhone === senderPhone) return res.status(400).json({ success: false, message: 'Cannot transfer to yourself.' });

    const recipient = db.users[recipientPhone];
    const txnId = 'OPY' + Math.floor(100000 + Math.random() * 900000);
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    sender.balance -= amount;
    sender.transactions.push({ id: txnId, title: `Transfer to ${recipient.firstname}`, type: 'debit', amount, details: `Acc: ${recipient.accountNumber}`, date: dateStr });
    sender.notifications.push({ title: 'Transfer Successful', message: `Sent ₦${amount.toLocaleString()} to ${recipient.firstname} (${recipient.accountNumber})`, date: dateStr, read: false });

    recipient.balance += amount;
    recipient.transactions.push({ id: txnId, title: `Transfer from ${sender.firstname}`, type: 'credit', amount, details: `Acc: ${sender.accountNumber}`, date: dateStr });
    recipient.notifications.push({ title: 'Money Received', message: `Received ₦${amount.toLocaleString()} from ${sender.firstname}`, date: dateStr, read: false });

    saveDb(db);
    res.json({ success: true, message: 'Transfer completed successfully!' });
});

// Simulated Services & Bill Payments
app.post('/api/service', (req, res) => {
    const { phone, serviceName, target, amount, pin } = req.body;
    const db = loadDb();
    const user = db.users[phone];

    if (!user || pin !== user.pin) return res.status(400).json({ success: false, message: 'Invalid PIN or user.' });
    if (amount > user.balance) return res.status(400).json({ success: false, message: 'Insufficient balance.' });

    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    user.balance -= amount;
    user.transactions.push({ id: 'SRV' + Math.floor(100000 + Math.random() * 900000), title: `${serviceName} Payment`, type: 'debit', amount, details: `Target: ${target}`, date: dateStr });
    user.notifications.push({ title: `${serviceName} Successful`, message: `Successfully paid ₦${amount.toLocaleString()} for ${serviceName}.`, date: dateStr, read: false });

    saveDb(db);
    res.json({ success: true, message: `${serviceName} payment successful!` });
});

app.listen(PORT, () => console.log(`OPay simulation running on port ${PORT}`));
