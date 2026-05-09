const { Server } = require('socket.io');

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    console.log(`client connected: ${socket.id}`);
    socket.on('disconnect', () => console.log(`client disconnected: ${socket.id}`));
  });

  return io;
}

module.exports = { initSocket };
