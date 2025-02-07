// frontend/src/components/Status.js

import React from 'react';
import './Status.css';

const Status = ({ status }) => {
  return (
    <div className="status">
      <h3>Bot Status: {status}</h3>
    </div>
  );
};

export default Status;
