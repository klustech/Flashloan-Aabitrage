// src/pages/Logs.js

import React from 'react';
import LogsViewer from '../components/LogsViewer';
import './Logs.css';

const Logs = () => {
  return (
    <div className="logs-page">
      <h2>General Logs</h2>
      <LogsViewer />
    </div>
  );
};

export default Logs;
