// src/axiosConfig.js

import axios from 'axios';

const axiosInstance = axios.create({
  baseURL: 'http://localhost:3001/api', // All API calls will be directed here.
  timeout: 10000,
});

export default axiosInstance;
