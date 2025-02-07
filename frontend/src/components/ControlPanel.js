// frontend/src/components/ControlPanel.js

import React from 'react';
import axios from '../axiosConfig';
import './ControlPanel.css';

const ControlPanel = ({ onStatusChange }) => {
  const handleStart = async () => {
    try {
      const response = await axios.post('/start');
      alert(response.data.status);
      if (onStatusChange) onStatusChange();
    } catch (error) {
      console.error('Error starting bot:', error);
      alert('Error starting bot.');
    }
  };

  const handleStop = async () => {
    try {
      const response = await axios.post('/stop');
      alert(response.data.status);
      if (onStatusChange) onStatusChange();
    } catch (error) {
      console.error('Error stopping bot:', error);
      alert('Error stopping bot.');
    }
  };

  return (
    <div className="control-panel">
      <button className="button" onClick={handleStart}>
        Start Bot
      </button>
      <button className="button" onClick={handleStop}>
        Stop Bot
      </button>
    </div>
  );
};

export default ControlPanel;
