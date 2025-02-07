// frontend/src/pages/Trades.js

import React from 'react';
import { Link } from 'react-router-dom';
import OpenTrades from '../components/OpenTrades';
import './Trades.css';

const TradesPage = () => {
  return (
    <div className="trades-page">
      <nav className="navbar">
        <Link to="/">Dashboard</Link>
        <Link to="/trades">Trades</Link>
        <Link to="/settings">Settings</Link>
      </nav>
      <h2>Open Trades</h2>
      <OpenTrades />
    </div>
  );
};

export default TradesPage;
