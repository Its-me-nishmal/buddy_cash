require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mongoose = require('mongoose');
const crypto = require('crypto');

// Load environment variables
const { MONGODB_URI, ADMIN_NUMBER, REFERRAL_LINK_BASE, GROUP_JID } = process.env;

// MongoDB Connection
mongoose.connect(MONGODB_URI).then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
    chatId: { type: String, unique: true },
    buddyCode: { type: String, unique: true },
    referrer: { type: String, default: null }, // Buddy Code of the referrer
    hasPaid: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false },
    earnings: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    name: { type: String, default: null },
    pendingApproval: { type: Boolean, default: false },
    rejectionReason: { type: String, default: null }, // Reason for rejection
    paymentHistory: [{
        type: { type: String }, // 'deposit', 'withdrawal', etc.
        amount: Number,
        date: { type: Date, default: Date.now },
        status: { type: String }, // 'pending', 'approved', 'rejected'
        reason: { type: String, default: null }, // Reason for rejection
    }],
    upiId: { type: String, default: null }, // User's UPI ID for withdrawals
    withdrawalPending: { type: Boolean, default: false }, // To restrict multiple pending withdrawals
});

const User = mongoose.model('User', userSchema);

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

// Generate QR Code for WhatsApp Web
client.on('qr', (qr) => {
    console.log('Scan this QR code to log in:');
    qrcode.generate(qr, { small: true });
});

// Ready Event
client.on('ready', () => {
    console.log('Buddy Cash Bot is ready!');
});

// Helper Function to Generate a Unique Buddy Code
async function generateBuddyCode() {
    let buddyCode;
    do {
        buddyCode = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 characters
    } while (await User.findOne({ buddyCode }));
    return buddyCode;
}

// Helper Function to Send Interactive Menu
async function sendMenu(chatId,cd) {
    const menu = `
*Buddy Cash Menu:*
1️⃣ Balance
2️⃣ Withdrawal 
3️⃣ History
4️⃣ My Buddies
5️⃣ Contact Admin (917994107442)
6️⃣ Buddy Message Formats

Your Buddy Code : *${cd}*

Reply with the number corresponding to your choice.
    `;
    client.sendMessage(chatId, menu);
}

// Helper Function to Send Buddy Message Formats
async function sendBuddyMessageFormats(chatId) {
    const formats = [
        `*Buddy Cash Registration:*\nUse your buddy code to register and earn rewards!\nExample: ABCDEFGHIJ`,
        `*Invite Your Friends:*\nShare your referral link to earn more!\nLink: ${REFERRAL_LINK_BASE}{YourBuddyCode}`,
        `*Support:*\nNeed help? Contact the admin at 917994107442.`,
        `*Withdrawal Request:*\nTo request a withdrawal, send 'withdraw' after providing your UPI ID and name.`,
    ];
    formats.forEach(format => {
        client.sendMessage(chatId, format);
    });
}

// Main Message Handler
client.on('message', async (msg) => {
    try {
        const chatId = msg.from;
        const sender = msg.author || chatId;
        const message = msg.body.trim();
        const lowerMessage = message.toLowerCase();
        const contact = await msg.getContact();
        const profileName = contact.pushname || 'User';

        let user = await User.findOne({ chatId: sender });

        // Handle Message Deletion Notifications
        if (msg.type === 'notification' && lowerMessage.includes('deleted a message')) {
            client.sendMessage(chatId, 'You cannot delete messages in this chat.');
            // Notify Admin about the deletion attempt
            client.sendMessage(
                ADMIN_NUMBER,
                `User ${sender} attempted to delete a message: "${message}"`
            );
            console.log(`User ${sender} attempted to delete a message: "${message}"`);
            return;
        }

        // If user is locked
        if (user && user.lockedUntil && new Date() < user.lockedUntil) {
            client.sendMessage(chatId, `You are locked out until ${user.lockedUntil.toLocaleString()}.`);
            return;
        }

        // If message is media (payment screenshot)
        if (msg.hasMedia) {
            if (!user) {
                client.sendMessage(chatId, 'You need to register first. Please enter your Buddy Code.');
                return;
            }

            if (user.hasPaid) {
                client.sendMessage(chatId, 'You have already submitted your payment screenshot.');
                return;
            }

            // Download media
            const media = await msg.downloadMedia();
            if (!media) {
                client.sendMessage(chatId, 'Failed to download media. Please try again.');
                return;
            }

            // Forward media to admin with user details
            const adminMessage = `New payment screenshot received from ${user.name || profileName}.\nBuddy Code: ${user.buddyCode}\nChat ID: ${sender}`;
            const mediaMessage = new MessageMedia(media.mimetype, media.data, 'screenshot.jpg');

            await client.sendMessage(ADMIN_NUMBER, adminMessage, { media: mediaMessage });

            // Update user status to pending approval
            user.pendingApproval = true;
            user.paymentHistory.push({ type: 'deposit', amount: 25, status: 'pending' }); // Assuming ₹25 payment
            await user.save();

            // Notify User
            client.sendMessage(chatId, 'Payment screenshot received. Awaiting admin approval.');

            return;
        }

        // Check if Admin is sending an approval or rejection command
        if (sender === ADMIN_NUMBER) {
            // Approve Deposit
            if (lowerMessage.startsWith('approve')) {
                const parts = message.split(' ');
                if (parts.length !== 2) {
                    client.sendMessage(chatId, 'Invalid approval format. Use: approve <chatId>');
                    return;
                }

                const targetChatId = parts[1];
                const targetUser = await User.findOne({ chatId: targetChatId, pendingApproval: true });

                if (!targetUser) {
                    client.sendMessage(chatId, 'No user found with the specified chat ID pending approval.');
                    return;
                }

                targetUser.isApproved = true;
                targetUser.hasPaid = true;
                targetUser.pendingApproval = false;
                // Update payment history status
                const lastPayment = targetUser.paymentHistory[targetUser.paymentHistory.length - 1];
                if (lastPayment && lastPayment.type === 'deposit' && lastPayment.status === 'pending') {
                    lastPayment.status = 'approved';
                }
                await targetUser.save();

                // Handle Referral Earnings
                const referrer = await User.findOne({ buddyCode: targetUser.referrer });
                if (referrer) {
                    // Update referrer's earnings and paymentHistory
                    referrer.earnings += 13;
                    referrer.paymentHistory.push({
                        type: 'deposit',
                        amount: 13,
                        date: new Date(),
                        status: 'approved',
                        reason: `Referral bonus from ${targetUser.buddyCode}`,
                    });
                    await referrer.save();

                    // Notify the first-level referrer
                    client.sendMessage(
                        referrer.chatId,
                        `🎉 Your Buddy Code just earned you ₹10! Your new balance is ₹${referrer.earnings}.`
                    );

                    // Handle Second-level referral
                    if (referrer.referrer) {
                        const secondReferrer = await User.findOne({ buddyCode: referrer.referrer });
                        if (secondReferrer) {
                            // Update second-level referrer's earnings and paymentHistory
                            secondReferrer.earnings += 2;
                            secondReferrer.paymentHistory.push({
                                type: 'deposit',
                                amount: 2,
                                date: new Date(),
                                status: 'approved',
                                reason: `Second-level referral bonus from ${referrer.buddyCode}`,
                            });
                            await secondReferrer.save();

                            // Notify the second-level referrer
                            client.sendMessage(
                                secondReferrer.chatId,
                                `🎉 Your second-level referral just earned you ₹2! Your new balance is ₹${secondReferrer.earnings}.`
                            );
                        }
                    }
                }

                // Notify User
                client.sendMessage(
                    targetUser.chatId,
                    `✅ Payment approved! Thank you, ${targetUser.name || profileName}! Your referrer has been credited. say Hi to more details !`
                );

                // Add user to group
                try {
                    const groupChat = await client.getChatById(GROUP_JID);
                    await groupChat.addParticipants([targetUser.chatId]);
                    client.sendMessage(chatId, `Payment approved and ${targetUser.name || profileName} added to the group.`);
                } catch (error) {
                    console.error('Error adding user to group:', error);
                    // If direct addition fails, send invite
                    const groupInvite = await client.getInviteCode(GROUP_JID);
                    const inviteLink = `https://chat.whatsapp.com/${groupInvite}`;
                    client.sendMessage(targetUser.chatId, `Join our group using this link: ${inviteLink}`);
                    client.sendMessage(chatId, `Payment approved. Failed to add user to group directly. Sent invite link.`);
                }

                return;
            }

            // Reject Deposit
            if (lowerMessage.startsWith('reject')) {
                const parts = message.split(' ');
                if (parts.length < 3) {
                    client.sendMessage(chatId, 'Invalid rejection format. Use: reject <chatId> <reason>');
                    return;
                }

                const targetChatId = parts[1];
                const reason = parts.slice(2).join(' ');

                const targetUser = await User.findOne({ chatId: targetChatId, pendingApproval: true });

                if (!targetUser) {
                    client.sendMessage(chatId, 'No user found with the specified chat ID pending approval.');
                    return;
                }

                targetUser.pendingApproval = false;
                targetUser.paymentHistory.push({ type: 'deposit', amount: 25, status: 'rejected', reason });
                targetUser.rejectionReason = reason;
                await targetUser.save();

                // Notify User
                client.sendMessage(
                    targetUser.chatId,
                    `❌ Your payment has been rejected by admin. Reason: ${reason}`
                );

                // Notify Admin
                client.sendMessage(chatId, `Payment rejected for ${targetUser.name || profileName} (${targetChatId}). Reason: ${reason}`);

                return;
            }

            // Approve Withdrawal
            if (lowerMessage.startsWith('approve_withdrawal')) {
                const parts = message.split(' ');
                if (parts.length !== 2) {
                    client.sendMessage(chatId, 'Invalid format. Use: approve_withdrawal <chatId>');
                    return;
                }

                const targetChatId = parts[1];
                const targetUser = await User.findOne({ chatId: targetChatId, withdrawalPending: true });

                if (!targetUser) {
                    client.sendMessage(chatId, 'No user found with the specified chat ID pending withdrawal approval.');
                    return;
                }

                // Update earnings and payment history
                targetUser.earnings -= 30; // Deduct the withdrawal amount
                targetUser.withdrawalPending = false;

                // Update the last withdrawal entry in paymentHistory
                const lastWithdrawal = targetUser.paymentHistory[targetUser.paymentHistory.length - 1];
                if (lastWithdrawal && lastWithdrawal.type === 'withdrawal' && lastWithdrawal.status === 'pending') {
                    lastWithdrawal.status = 'approved';
                }
                await targetUser.save();

                // Notify User
                client.sendMessage(
                    targetUser.chatId,
                    `✅ Your withdrawal of ₹30 has been approved and sent to your UPI ID (${targetUser.upiId}). Your new balance is ₹${targetUser.earnings}.`
                );

                // Notify Admin
                client.sendMessage(chatId, `Withdrawal of ₹30 approved for ${targetUser.name || profileName} (${targetChatId}).`);

                return;
            }

            // Reject Withdrawal
            if (lowerMessage.startsWith('with_re')) {
                const parts = message.split(' ');
                if (parts.length < 3) {
                    client.sendMessage(chatId, 'Invalid format. Use: reject_withdrawal <chatId> <reason>');
                    return;
                }

                const targetChatId = parts[1];
                const reason = parts.slice(2).join(' ');

                const targetUser = await User.findOne({ chatId: targetChatId, withdrawalPending: true });

                if (!targetUser) {
                    client.sendMessage(chatId, 'No user found with the specified chat ID pending withdrawal approval.');
                    return;
                }

                targetUser.withdrawalPending = false;

                // Update the last withdrawal entry in paymentHistory
                targetUser.paymentHistory.push({ type: 'withdrawal', amount: 30, status: 'rejected', reason });
                await targetUser.save();

                // Notify User
                client.sendMessage(
                    targetUser.chatId,
                    `❌ Your withdrawal of ₹30 has been rejected by admin. Reason: ${reason}`
                );

                // Notify Admin
                client.sendMessage(chatId, `Withdrawal of ₹30 rejected for ${targetUser.name || profileName} (${targetChatId}). Reason: ${reason}`);

                return;
            }

            // Future: Handle other admin commands here
        }

        // Registration Flow
        if (!user) {
            // Expecting Buddy Code (possibly with referrer code)
            if ( /^[A-Za-z0-9]+$/.test(message)) {
                const referrerCode = message;

                let finalReferrer = null;

                if (referrerCode !== 'ADMINADMIN') {
                    var referrer = await User.findOne({ buddyCode: referrerCode });
                    if (referrer) {
                        finalReferrer = referrerCode;
                    } else {
                        client.sendMessage(chatId, 'Invalid referrer Buddy Code. Please enter a valid 10-character Buddy Code');
                        return;
                    }
                }

                // Generate unique Buddy Code for the user
                const generatedBuddyCode = await generateBuddyCode();

                user = new User({
                    chatId: sender,
                    buddyCode: generatedBuddyCode,
                    referrer: finalReferrer
                });

                // If referrer is ADMINADMIN or no referrer, approve automatically
                if (finalReferrer === null || referrerCode === 'ADMINADMIN') {
                    user.isApproved = true;
                    user.hasPaid = true;
                    await user.save();

                    // Add user to group
                    try {
                        await client.addParticipant(GROUP_JID, user.chatId);
                        client.sendMessage(chatId, `Buddy Code ${generatedBuddyCode} registered without a referrer. Your account is approved automatically and added to the group.`);
                    } catch (error) {
                        console.error('Error adding user to group:', error);
                        // If direct addition fails, send invite
                        const groupInvite = await client.getInviteCode(GROUP_JID);
                        const inviteLink = `https://chat.whatsapp.com/${groupInvite}`;
                        client.sendMessage(user.chatId, `Join our group using this link: ${inviteLink}`);
                        client.sendMessage(chatId, `Buddy Code ${generatedBuddyCode} registered without a referrer. Your account is approved automatically. Sent invite link to join the group.`);
                    }

                    client.sendMessage(
                        chatId,
                        `Share this link to make money: ${REFERRAL_LINK_BASE}${generatedBuddyCode}\n`
                    );
                } else {
                    await user.save();
                    client.sendMessage(chatId, `Buddy Code ${generatedBuddyCode} registered with Your Buddy ${referrer.name}. Please provide your name to complete registration.`);
                }

                return;
            } else {
                client.sendMessage(chatId, 'Welcome to Buddy Cash! Please enter your 10-character Buddy Code to start your journey. Example: ABCDEFGHIJ');
                return;
            }
        }

        // After registering, prompt for name if not provided
        if (!user.name) {
            user.name = message;
            await user.save();
            client.sendMessage(chatId, `Thank you, ${user.name}. Please send your ₹20 payment screenshot for verification.  send register fee to nishmal@sbi`);
            return;
        }

        // Handle interactive menu for greetings
        const greetings = ['hi', 'hello', 'hlo', 'haai', 'hey'];
        if (greetings.includes(lowerMessage)) {
            sendMenu(chatId,user.buddyCode);
            return;
        }

        // Handle menu selections
        if (['1', '2', '3', '4', '5'].includes(message)) {
            switch (message) {
                case '1':
                    client.sendMessage(chatId, `💰 *Your Current Balance:* ₹${user.earnings}.`);
                    break;
                case '2':
                    client.sendMessage(chatId, `Use: withdraw <amount>\n*Example:* withdraw 50`);
                    break;
                case '3':
                    if (user.paymentHistory.length === 0) {
                        client.sendMessage(chatId, '📄 No transactions found.');
                    } else {
                        let history = '*📊 Your Payment History:*\n';
                        user.paymentHistory.forEach((entry, index) => {
                            history += `${index + 1}. ${entry.type === 'deposit' ? 'Deposit' : 'Withdrawal'} of ₹${entry.amount} on ${new Date(entry.date).toLocaleString()} - Status: ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}\n`;
                        });
                        client.sendMessage(chatId, history);
                    }
                    break;
                case '4':
                    const buddies = await User.find({ referrer: user.buddyCode });
                    if (buddies.length === 0) {
                        client.sendMessage(chatId, '👥 You have no buddies yet.');
                    } else {
                        let buddiesList = '*👥 Your Buddies:*\n';
                        buddies.forEach((buddy, index) => {
                            buddiesList += `${index + 1}. ${buddy.name || 'Unnamed'} - Buddy Code: ${buddy.buddyCode}\n`;
                        });
                        client.sendMessage(chatId, buddiesList);
                    }
                    break;
                case '5':
                    client.sendMessage(chatId, '📞 You can contact the admin at *917994107442* for any assistance.');
                    break;
                case '6':
                    await sendBuddyMessageFormats(chatId);
                    break;
                default:
                    client.sendMessage(chatId, '❗ Invalid option. Please select a number from the menu.');
            }
            return;
        }

        // Handle withdrawal requests
        if (lowerMessage.startsWith('withdraw')) {
            // Expected format: 'withdraw <amount>'
            const parts = message.split(' ');
            if (parts.length !== 2) {
                client.sendMessage(chatId, '❗ Invalid format. Use: withdraw <amount>\n*Example:* withdraw 50');
                return;
            }
        
            const amount = parseFloat(parts[1]);
        
            if (isNaN(amount)) {
                client.sendMessage(chatId, '❗ Please enter a valid number for the withdrawal amount.');
                return;
            }
        
            if (amount < 30) {
                client.sendMessage(chatId, '⚠️ The minimum withdrawal amount is ₹25.');
                return;
            }
        
            if (!user.isApproved) {
                client.sendMessage(chatId, '⚠️ Your account is not approved for withdrawals yet.');
                return;
            }
        
            if (user.earnings < amount) {
                client.sendMessage(chatId, `⚠️ You do not have enough balance. Your current balance is ₹${user.earnings}.`);
                return;
            }
        
            if (user.withdrawalPending) {
                client.sendMessage(chatId, '⏳ You already have a pending withdrawal request. Please wait for it to be processed.');
                return;
            }
        
            // Check if UPI ID and Name are provided
            if (!user.upiId || !user.name) {
                client.sendMessage(chatId, '📄 Please provide your UPI ID and name to proceed with the withdrawal.\n*Format:* UPI <UPI_ID> <Name>');
                return;
            }
        
            // Proceed with withdrawal request
            user.withdrawalPending = true;
            user.paymentHistory.push({ type: 'withdrawal', amount: amount, status: 'pending' });
            await user.save();
        
            // Notify Admin
            client.sendMessage(
                ADMIN_NUMBER,
                `💸 *Withdrawal Request:*\nUser: ${user.name || profileName} (${user.chatId})\nAmount: ₹${amount}\nUPI ID: ${user.upiId}`
            );
        
            // Notify User
            client.sendMessage(chatId, `✅ Your withdrawal request of ₹${amount} has been submitted and is pending admin approval.`);
        
            return;
        }
        

        // Handle providing UPI ID and name
        if (lowerMessage.startsWith('upi')) {
            const parts = message.split(' ');
            if (parts.length < 3) {
                client.sendMessage(chatId, '❗ Invalid format. Use: UPI <UPI_ID> <Name>');
                return;
            }

            const upiId = parts[1];
            const name = parts.slice(2).join(' ');

            user.upiId = upiId;
            user.name = name;
            await user.save();

            client.sendMessage(chatId, '✅ Your UPI ID and name have been updated successfully.');

            return;
        }

        // If user has not paid yet
        if (!user.hasPaid) {
            client.sendMessage(chatId, '💳 Please send your ₹20 payment screenshot for verification. send register fee to nishmal@sbi');
            return;
        }

        // If user is not approved yet
        if (!user.isApproved) {
            client.sendMessage(chatId, '⏳ Your payment is awaiting admin approval. Please wait for confirmation. estimate - within 3 hours');
            return;
        }

        // After approval, respond with referral link and balance
        const referralLink = `${REFERRAL_LINK_BASE}${user.buddyCode}`;
        client.sendMessage(
            chatId,
            `🔗 *Share this link to make money:* ${referralLink}\n💰 *Your balance:* ₹${user.earnings}.`
        );
    } catch (e) { 
        console.log('Error in message handler:', e); 
    }
});

// Prevent Deletion Notifications
client.on('message_revoke_everyone', async (after, before) => {
    if (before) {
        const sender = before.author || before.from;

        // Notify the user
        client.sendMessage(
            sender,
            '🚫 You cannot delete messages in this chat.'
        );

        // Optionally, send the deleted message content
        if (before.body) {
            client.sendMessage(
                sender,
                `🔍 Your deleted message was: "${before.body}"`
            );
        } else {
            client.sendMessage(
                sender,
                '🔍 You deleted a media message.'
            );
        }

        // Notify admin about the deletion attempt
        client.sendMessage(
            ADMIN_NUMBER,
            `⚠️ User ${sender} attempted to delete a message: "${before.body || '[Media]'}"`
        );

        console.log(`User ${sender} attempted to delete a message: "${before.body || '[Media]'}"`);
    }
});

// Additional Event Handlers

// Incoming Call Handler
client.on('call', async (call) => {
    const callerId = call.from; // The contact who initiated the call
    console.log(`📞 Incoming call from ${callerId}`);

    // Notify Admin about the incoming call
    client.sendMessage(
        ADMIN_NUMBER,
        `📞 Received a call from ${callerId}. Currently, the bot does not handle calls.`
    );

    // Send a message to the caller
    client.sendMessage(
        callerId,
        '🤖 Hi! I am Buddy Cash Bot. I handle messages related to Buddy Cash. Please leave a message instead of calling.'
    );

    // Optionally, block the caller if necessary
    // await client.contactBlock(callerId);
});

// Typing Indicator Handler
client.on('typing', (chatId, contact, isTyping) => {
    if (isTyping) {
        console.log(`📝 ${contact.pushname || contact.number} is typing in chat ${chatId}`);
        // Optionally, notify admin that the user is typing
        client.sendMessage(
            ADMIN_NUMBER,
            `📝 ${contact.pushname || contact.number} is typing in chat ${chatId}.`
        );
    }
});

// Group Join Handler
client.on('group_join', async (notification) => {
    const groupId = notification.id.remote;
    const participant = notification.participant; // The user who joined

    console.log(`👥 ${participant} joined the group ${groupId}`);

    // Send a welcome message to the group
    client.sendMessage(
        groupId,
        `👋 Welcome ${participant}! Thanks for joining the Buddy Cash Bot Group.`
    );

    // Notify admin about the new member
    client.sendMessage(
        ADMIN_NUMBER,
        `👥 ${participant} has joined the group ${groupId}.`
    );
});

// Group Leave Handler
client.on('group_leave', async (notification) => {
    const groupId = notification.id.remote;
    const participant = notification.participant; // The user who left

    console.log(`👤 ${participant} left the group ${groupId}`);

    // Send a farewell message to the group
    client.sendMessage(
        groupId,
        `👋 Goodbye ${participant}. We're sorry to see you go.`
    );

    // Notify admin about the member leaving
    client.sendMessage(
        ADMIN_NUMBER,
        `👤 ${participant} has left the group ${groupId}.`
    );
});

// Group Update Handler
client.on('group_update', async (notification) => {
    const groupId = notification.id.remote;
    const oldGroupData = notification.oldData;
    const newGroupData = notification.newData;

    // Example: Detect if the group subject has changed
    if (oldGroupData.subject !== newGroupData.subject) {
        client.sendMessage(
            groupId,
            `📝 The group name has been changed from "${oldGroupData.subject}" to "${newGroupData.subject}".`
        );

        // Notify admin about the group update
        client.sendMessage(
            ADMIN_NUMBER,
            `📝 Group ${groupId} changed its name from "${oldGroupData.subject}" to "${newGroupData.subject}".`
        );
    }
});

// Battery Status Handler
client.on('battery', (batteryInfo) => {
    console.log(`🔋 Battery Level: ${batteryInfo.level}% - Is Plugged In: ${batteryInfo.isPlugged}`);

    // Notify admin if battery is low
    if (batteryInfo.level <= 20 && !batteryInfo.isPlugged) {
        client.sendMessage(
            ADMIN_NUMBER,
            `⚠️ Warning: Battery level is low (${batteryInfo.level}%). Please charge the device running the bot.`
        );
    }
});

// Client State Change Handler
client.on('change_state', (state) => {
    console.log(`🔄 Client state changed to ${state}`);

    // Notify admin about the state change
    client.sendMessage(
        ADMIN_NUMBER,
        `🔄 Buddy Cash Bot client state changed to: ${state}`
    );
});

// Initialize the Client
client.initialize()


const express = require('express');
const app = express();
const PORT = 3000;

// Health Check Endpoint
app.get('/', (req, res) => {
    res.json({ success: true });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// Health Check Every Minute
setInterval(() => {
    console.log('Health check triggered');
    fetch(`https://buddy-cash.onrender.com`)
        .then(res => res.json())
        .then(data => console.log('Health Check Response:', data))
        .catch(err => console.error('Health Check Error:', err));
}, 60000); // 60000 ms = 1 minute
