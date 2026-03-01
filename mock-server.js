import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/v1/system/pair-client', (req, res) => {
  console.log('Received pair-client request:', req.body);
  const { mac_address } = req.body;
  if (!mac_address || mac_address === 'unknown') {
    return res.status(400).json({ error: 'Valid MAC address required' });
  }
  return res.status(200).json({ message: 'Approved' });
});

app.post('/api/v1/auth/login', (req, res) => {
  console.log('Received login request:', req.body);
  const { username, password } = req.body;
  if (username === 'admin' && password === 'password') {
    return res.status(200).json({ token: 'mock_jwt_token', user: { id: 1, name: 'Admin Cashier' } });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Mock Main Server running on http://localhost:${PORT}`);
});
