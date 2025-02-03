// src/pages/Trades.js

import React from 'react';
import Trades from '../components/Trades';
import './Trades.css';

const TradesPage = () => {
  return (
    <div className="trades-page">
      <h2>Successful Trades</h2>
      <Trades />
    </div>
  );
};

export default TradesPage;
