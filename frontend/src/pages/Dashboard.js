// src/pages/Dashboard.js

import React, { useState, useEffect } from 'react';
import axios from '../axiosConfig';
import OpenTrades from '../components/OpenTrades';
import ControlPanel from '../components/ControlPanel';
import Status from '../components/Status';
import './Dashboard.css';

const Dashboard = () => {
  const [botStatus, setBotStatus] = useState('Unknown');

  const fetchStatus = async () => {
    try {
      const response = await axios.get('/status');
      setBotStatus(response.data.status);
    } catch (error) {
      console.error('Error fetching bot status:', error);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="dashboard">
      <h2>Dashboard</h2>
      <Status status={botStatus} />
      <ControlPanel onStatusChange={fetchStatus} />
      {/* New OpenTrades component replaces the detected pairs log */}
      <OpenTrades />
    </div>
  );
};

export default Dashboard;
