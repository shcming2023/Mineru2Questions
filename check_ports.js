
import net from 'net';

[3000, 3001, 3002].forEach(port => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} is in use`);
      } else {
        console.log(`Port ${port} error: ${err.message}`);
      }
    });
    server.once('listening', () => {
      console.log(`Port ${port} is free`);
      server.close();
    });
    server.listen(port);
});
