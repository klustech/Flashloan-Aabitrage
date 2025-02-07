// frontend/src/axiosConfig.js

import axios from 'axios';

// Create an instance of Axios with default settings.
// Adjust the baseURL to match your backend server configuration.
const instance = axios.create({
  baseURL: 'http://localhost:3001/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export default instance;
