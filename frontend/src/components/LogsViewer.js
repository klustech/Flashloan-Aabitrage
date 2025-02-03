// src/components/LogsViewer.js

import React, { useState, useEffect } from 'react';
import axios from '../axiosConfig';
import './LogsViewer.css';

const LogsViewer = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchLogs = async () => {
    try {
      const response = await axios.get('/logs');
      setLogs(response.data);
    } catch (error) {
      console.error('Error fetching logs:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="logs-viewer">
      <h2>General Logs</h2>
      {loading ? (
        <p>Loading logs...</p>
      ) : logs.length > 0 ? (
        <div className="logs-table-container">
          <div className="logs-table">
            <div className="logs-table-header">
              <div className="logs-header-cell">Timestamp</div>
              <div className="logs-header-cell">Level</div>
              <div className="logs-header-cell">Message</div>
            </div>
            {logs.map((log, index) => (
              <div key={index} className={`logs-table-row logs-${log.level.toLowerCase()}`}>
                <div className="logs-cell">{new Date(log.timestamp).toLocaleString()}</div>
                <div className="logs-cell">{log.level.toUpperCase()}</div>
                <div className="logs-cell">
                  {log.message.includes('0x') || log.message.includes('ETH') ? (
                    <pre>{log.message}</pre>
                  ) : (
                    log.message
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p>No logs available yet.</p>
      )}
    </div>
  );
};

export default LogsViewer;
