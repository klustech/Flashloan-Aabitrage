const WebSocket = require('ws');

const ws = new WebSocket('wss://mainnet.infura.io/ws/v3/e731a404e7e542038fb8cd0d5d83f763');

ws.on('open', function open() {
  console.log('Connected to WebSocket');
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_blockNumber",
    params: []
  }));
});

ws.on('message', function incoming(data) {
  console.log(`Received: ${data}`);
  ws.close();
});

ws.on('error', function error(err) {
  console.error('WebSocket error:', err);
});
