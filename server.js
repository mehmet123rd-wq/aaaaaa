const express = require('express');
const app = express();

// index.html ve diğer statik dosyaları tarayıcıya sunar (Cannot GET / hatasını önler)
app.use(express.static(__dirname));

const http = require('http').createServer(app);
const { ExpressPeerServer } = require('peer');
const yts = require('yt-search');

const io = require('socket.io')(http, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// PeerJS Sunucusunu Express HTTP sunucusuna entegre ediyoruz (Railway uyumlu)
const peerServer = ExpressPeerServer(http, {
  debug: true,
  path: '/'
});
app.use('/peerjs', peerServer);

const channelsDB = {
  "Genel Kanal": { password: "123456", owner: "Sistem" }
};

const usersDB = {
  "admin": { 
    password: "123456", 
    approved: true, 
    avatar: "", 
    status: "Yönetici",
    friends: [], 
    friendRequests: [] 
  }
};

let activeRoomUsers = {}; 
let userSocketMap = {}; // Kullanıcı adı ile socket.id eşlemesi için
let socketUserMap = {}; // socket.id ile kullanıcı adı eşlemesi için (Disconnect yönetimi için eklendi)

io.on('connection', (socket) => {
  
  socket.on('register-user', (data) => {
    let { username, password } = data;
    if (!username || !password) {
      return socket.emit('register-result', { success: false, message: "Kullanıcı adı ve şifre boş olamaz!" });
    }
    username = username.trim();
    const existingUser = Object.keys(usersDB).find(u => u.toLowerCase() === username.toLowerCase());
    if (existingUser) {
      return socket.emit('register-result', { success: false, message: "Bu kullanıcı adı zaten alınmış!" });
    }

    usersDB[username] = { password: password, approved: false, avatar: "", status: "", friends: [], friendRequests: [] };
    socket.emit('register-result', { success: true, message: "Kayıt talebiniz alındı! Yönetici onayından sonra giriş yapabilirsiniz." });
    io.emit('new-pending-user', username);
  });

  socket.on('auth-check', (data) => {
    const { username, password } = data;
    const user = usersDB[username];

    if (!user) {
      return socket.emit('auth-result', { success: false, message: "Böyle bir kullanıcı bulunamadı!" });
    }
    if (user.password !== password) {
      return socket.emit('auth-result', { success: false, message: "Şifreniz hatalı!" });
    }
    if (!user.approved) {
      return socket.emit('auth-result', { success: false, message: "Hesabınız henüz yönetici tarafından onaylanmadı!" });
    }

    userSocketMap[username] = socket.id;
    socketUserMap[socket.id] = username; // Disconnect için kaydediyoruz
    
    const isAdmin = (username === 'admin');
    let pendingUsers = isAdmin ? Object.keys(usersDB).filter(u => !usersDB[u].approved) : [];

    socket.emit('auth-result', { 
      success: true, 
      isAdmin: isAdmin, 
      pendingUsers: pendingUsers,
      allUsers: usersDB,
      channels: channelsDB,
      avatar: user.avatar || "",
      status: user.status || "",
      friends: user.friends || [],
      friendRequests: user.friendRequests || []
    });
  });

  socket.on('update-username', (data) => {
    const { oldUsername, newUsername } = data;
    const cleanNew = newUsername.trim();
    if (!cleanNew) return socket.emit('settings-action-result', { success: false, message: "Kullanıcı adı boş olamaz!" });
    if (usersDB[cleanNew]) return socket.emit('settings-action-result', { success: false, message: "Bu kullanıcı adı zaten kullanımda!" });

    usersDB[cleanNew] = usersDB[oldUsername];
    delete usersDB[oldUsername];
    
    if (userSocketMap[oldUsername]) {
      userSocketMap[cleanNew] = userSocketMap[oldUsername];
      socketUserMap[userSocketMap[oldUsername]] = cleanNew; // Socket map güncellendi
      delete userSocketMap[oldUsername];
    }
    socket.emit('settings-action-result', { success: true, message: "Kullanıcı adı güncellendi!", newUsername: cleanNew });
  });

  socket.on('update-status', (data) => {
    const { username, status } = data;
    if (usersDB[username] && usersDB[username].approved) {
      usersDB[username].status = status;
      socket.emit('settings-action-result', { success: true, message: "Durum güncellendi!" });
      io.emit('user-status-changed', { username, status });
    }
  });

  socket.on('update-password', (data) => {
    const { username, oldPassword, newPassword } = data;
    if (!usersDB[username]) return socket.emit('settings-action-result', { success: false, message: "Kullanıcı bulunamadı!" });
    if (usersDB[username].password !== oldPassword) return socket.emit('settings-action-result', { success: false, message: "Mevcut şifreniz yanlış!" });

    usersDB[username].password = newPassword;
    socket.emit('settings-action-result', { success: true, message: "Şifreniz başarıyla değiştirildi!" });
  });

  socket.on('update-avatar', (data) => {
    const { username, avatar } = data;
    if (usersDB[username] && usersDB[username].approved) {
      usersDB[username].avatar = avatar;
      socket.emit('avatar-update-result', { success: true, avatar: avatar });
      io.emit('user-avatar-changed', { username, avatar });
    }
  });

  socket.on('send-friend-request', (data) => {
    const { sender, targetUser } = data;
    if (!usersDB[sender] || !usersDB[sender].approved) return;
    if (!usersDB[targetUser]) return socket.emit('friend-action-result', { success: false, message: "Kullanıcı bulunamadı!" });
    if (sender === targetUser) return socket.emit('friend-action-result', { success: false, message: "Kendinize istek atamazsınız!" });
    if (usersDB[targetUser].friends.includes(sender)) return socket.emit('friend-action-result', { success: false, message: "Zaten arkadaşsınız!" });
    if (usersDB[targetUser].friendRequests.includes(sender)) return socket.emit('friend-action-result', { success: false, message: "Zaten istek gönderilmiş!" });

    usersDB[targetUser].friendRequests.push(sender);
    socket.emit('friend-action-result', { success: true, message: "İstek gönderildi!" });
    io.emit('friend-request-received', { targetUser, sender });
  });

  socket.on('respond-friend-request', (data) => {
    const { username, sender, accept } = data;
    if (!usersDB[username] || !usersDB[username].approved) return;
    if (usersDB[username] && usersDB[sender]) {
      usersDB[username].friendRequests = usersDB[username].friendRequests.filter(u => u !== sender);
      if (accept) {
        if (!usersDB[username].friends.includes(sender)) usersDB[username].friends.push(sender);
        if (!usersDB[sender].friends.includes(username)) usersDB[sender].friends.push(username);
      }
      socket.emit('friend-response-result', { success: true, friends: usersDB[username].friends, requests: usersDB[username].friendRequests });
      io.emit('friend-list-updated', { user1: username, user2: sender });
    }
  });

  socket.on('create-channel', (data) => {
    const { creatorUser, channelName, channelPassword } = data;
    if (!usersDB[creatorUser] || !usersDB[creatorUser].approved) return;
    if (channelsDB[channelName]) return socket.emit('channel-create-result', { success: false, message: "Bu kanal zaten var!" });
    channelsDB[channelName] = { password: channelPassword || "", owner: creatorUser };
    io.emit('update-channels', channelsDB);
    socket.emit('channel-create-result', { success: true });
  });

  socket.on('verify-channel-password', (data) => {
    const { channelName, password, username } = data;
    if (usersDB[username] && !usersDB[username].approved) return;
    const channel = channelsDB[channelName];
    if (!channel) return socket.emit('channel-auth-result', { success: false, message: "Kanal bulunamadı!" });
    if (!channel.password || channel.password === password) {
      socket.emit('channel-auth-result', { success: true });
    } else {
      socket.emit('channel-auth-result', { success: false, message: "Şifre yanlış!" });
    }
  });

  socket.on('approve-user', (data) => {
    const { adminUser, targetUser } = data;
    if (adminUser === 'admin' && usersDB[targetUser]) {
      usersDB[targetUser].approved = true;
      io.emit('user-approved', targetUser);
    }
  });

  socket.on('ban-user', (data) => {
    const { adminUser, targetUser } = data;
    if (adminUser === 'admin' && usersDB[targetUser] && targetUser !== 'admin') {
      delete usersDB[targetUser];
      const targetSocketId = userSocketMap[targetUser];
      if (targetSocketId) {
        io.to(targetSocketId).emit('user-banned');
      }
    }
  });

  socket.on('play-music-request', async (data) => {
    const { roomId, query, username } = data;
    if (usersDB[username] && !usersDB[username].approved) return;
    try {
      const searchResult = await yts(query);
      if (searchResult && searchResult.videos && searchResult.videos.length > 0) {
        const video = searchResult.videos[0];
        const embedUrl = `https://www.youtube.com/embed/${video.videoId}?autoplay=1&enablejsapi=1`;
        io.to(roomId).emit('play-music-response', { title: video.title, url: embedUrl, duration: video.timestamp });
        io.to(roomId).emit('receive-message', { user: "🎶 Müzik Botu", avatar: "", message: `Çalmaya başladı: **${video.title}**`, file: null });
      } else {
        socket.emit('music-error', "Şarkı bulunamadı.");
      }
    } catch (err) {
      socket.emit('music-error', "Arama yapılırken hata oluştu.");
    }
  });

  socket.on('stop-music-request', (data) => {
    const { roomId, username } = data;
    if (usersDB[username] && !usersDB[username].approved) return;
    io.to(roomId).emit('stop-music-response');
  });

  // Kullanıcı Odaya Katıldığında
  socket.on('join-room', (roomId, userId, username) => {
    if (!usersDB[username] || !usersDB[username].approved) {
      return socket.emit('unauthorized-action', "Hesabınız onaylanmamış!");
    }
    
    // Eski odalardan çıkış yapmasını sağlıyoruz ki socket çakışmasın
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });

    socket.join(roomId);
    socket.roomId = roomId; // Disconnect durumunda kullanmak için odayı socket objesine yazıyoruz
    userSocketMap[username] = socket.id;
    socketUserMap[socket.id] = username;

    if (!activeRoomUsers[roomId]) activeRoomUsers[roomId] = [];
    if (!activeRoomUsers[roomId].includes(username)) activeRoomUsers[roomId].push(username);

    io.emit('update-active-users', activeRoomUsers);
    const userAvatar = usersDB[username] ? usersDB[username].avatar : "";
    
    // Odaya katıldığını odadaki DİĞER kullanıcılara bildiriyoruz
    socket.to(roomId).emit('user-connected', userId, username, userAvatar);
  });

  // DOĞRU KAPSAM: Mesaj gönderme işlemi join-room'un DIŞINDA ana blokta olmalı
  socket.on('send-message', (data) => {
    if (data.roomId) {
      // Mesajı odaya (gönderen hariç) sorunsuzca iletiyoruz
      socket.to(data.roomId).emit('receive-message', { 
        user: data.user, 
        avatar: data.avatar, 
        message: data.message, 
        file: data.file 
      });
    }
  });

  socket.on('typing', (data) => {
    if (data.roomId) socket.to(data.roomId).emit('user-typing', { username: data.username });
  });

  socket.on('stop-typing', (data) => {
    if (data.roomId) socket.to(data.roomId).emit('user-stop-typing', { username: data.username });
  });

  // DOĞRU KAPSAM: Disconnect olayı da ana blokta olmalıdır.
  socket.on('disconnect', () => {
    const username = socketUserMap[socket.id];
    
    if (username) {
      for (let rId in activeRoomUsers) {
        activeRoomUsers[rId] = activeRoomUsers[rId].filter(u => u !== username);
      }
      io.emit('update-active-users', activeRoomUsers);
      
      if (socket.roomId) {
        socket.to(socket.roomId).emit('user-disconnected', socket.id);
      }
      
      delete userSocketMap[username];
      delete socketUserMap[socket.id];
    }
  });

});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif: http://localhost:${PORT}`);
});