// frontend/src/pages/Settings.js

import React, { useState, useEffect } from 'react';
import axios from '../axiosConfig';
import './Settings.css';

const Settings = () => {
  // Initial state now uses MIN_BASE_TOKEN_RESERVE instead of MINIMUM_LOCKED_ETH
  const [settings, setSettings] = useState({
    ETH_AMOUNT_TO_SWAP: '0.05',
    SLIPPAGE_TOLERANCE: 5,
    GAS_PRICE_MULTIPLIER: 1.2,
    PROFIT_THRESHOLD: 10,
    DEADLINE_BUFFER: 60,
    MAX_GAS_PRICE: '200',
    TOKEN_WHITELIST: '',
    TOKEN_BLACKLIST: '',
    FLASHBOTS_ENABLED: false,
    MIN_BASE_TOKEN_RESERVE: '5'  // default value for base token reserve
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch current settings from the backend.
  const fetchSettings = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/settings');
      const fetched = response.data;
      setSettings({
        ETH_AMOUNT_TO_SWAP: fetched.ETH_AMOUNT_TO_SWAP || '0.05',
        SLIPPAGE_TOLERANCE: fetched.SLIPPAGE_TOLERANCE || 5,
        GAS_PRICE_MULTIPLIER: fetched.GAS_PRICE_MULTIPLIER || 1.2,
        PROFIT_THRESHOLD: fetched.PROFIT_THRESHOLD || 10,
        DEADLINE_BUFFER: fetched.DEADLINE_BUFFER || 60,
        MAX_GAS_PRICE: fetched.MAX_GAS_PRICE || '200',
        TOKEN_WHITELIST: Array.isArray(fetched.TOKEN_WHITELIST)
          ? fetched.TOKEN_WHITELIST.join(', ')
          : '',
        TOKEN_BLACKLIST: Array.isArray(fetched.TOKEN_BLACKLIST)
          ? fetched.TOKEN_BLACKLIST.join(', ')
          : '',
        FLASHBOTS_ENABLED: fetched.FLASHBOTS_ENABLED === true,
        MIN_BASE_TOKEN_RESERVE: fetched.MIN_BASE_TOKEN_RESERVE !== undefined 
          ? fetched.MIN_BASE_TOKEN_RESERVE.toString() 
          : '5'
      });
    } catch (err) {
      console.error('Error fetching settings:', err);
      setError('Failed to fetch settings.');
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  // Send updated settings to the backend.
  const updateSettingsHandler = async () => {
    setLoading(true);
    try {
      const updated = {
        ETH_AMOUNT_TO_SWAP: settings.ETH_AMOUNT_TO_SWAP,
        SLIPPAGE_TOLERANCE: parseFloat(settings.SLIPPAGE_TOLERANCE),
        GAS_PRICE_MULTIPLIER: parseFloat(settings.GAS_PRICE_MULTIPLIER),
        PROFIT_THRESHOLD: parseFloat(settings.PROFIT_THRESHOLD),
        DEADLINE_BUFFER: parseInt(settings.DEADLINE_BUFFER, 10),
        MAX_GAS_PRICE: settings.MAX_GAS_PRICE,
        TOKEN_WHITELIST: settings.TOKEN_WHITELIST 
          ? settings.TOKEN_WHITELIST.split(',').map(addr => addr.trim()) 
          : [],
        TOKEN_BLACKLIST: settings.TOKEN_BLACKLIST 
          ? settings.TOKEN_BLACKLIST.split(',').map(addr => addr.trim()) 
          : [],
        FLASHBOTS_ENABLED: settings.FLASHBOTS_ENABLED,
        // Update MIN_BASE_TOKEN_RESERVE rather than MINIMUM_LOCKED_ETH
        MIN_BASE_TOKEN_RESERVE: parseFloat(settings.MIN_BASE_TOKEN_RESERVE)
      };
      await axios.post('/settings', updated);
      alert('Settings updated successfully!');
      fetchSettings();
    } catch (err) {
      console.error('Error updating settings:', err);
      setError('Failed to update settings.');
    }
    setLoading(false);
  };

  return (
    <div className="settings-page">
      <h2>Settings</h2>
      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}
      <form className="settings-form" onSubmit={e => e.preventDefault()}>
        <label>
          ETH Amount to Swap:
          <input
            type="number"
            step="0.01"
            value={settings.ETH_AMOUNT_TO_SWAP}
            onChange={e => setSettings({...settings, ETH_AMOUNT_TO_SWAP: e.target.value})}
          />
        </label>
        <label>
          Slippage Tolerance (%):
          <input
            type="number"
            value={settings.SLIPPAGE_TOLERANCE}
            onChange={e => setSettings({...settings, SLIPPAGE_TOLERANCE: e.target.value})}
          />
        </label>
        <label>
          Gas Price Multiplier:
          <input
            type="number"
            step="0.1"
            value={settings.GAS_PRICE_MULTIPLIER}
            onChange={e => setSettings({...settings, GAS_PRICE_MULTIPLIER: e.target.value})}
          />
        </label>
        <label>
          Profit Threshold (%):
          <input
            type="number"
            value={settings.PROFIT_THRESHOLD}
            onChange={e => setSettings({...settings, PROFIT_THRESHOLD: e.target.value})}
          />
        </label>
        <label>
          Deadline Buffer (seconds):
          <input
            type="number"
            value={settings.DEADLINE_BUFFER}
            onChange={e => setSettings({...settings, DEADLINE_BUFFER: e.target.value})}
          />
        </label>
        {/* Replace the old Minimum Liquidity field with this new one */}
        <label>
          Minimum Base Token Reserve (ETH):
          <input
            type="number"
            step="0.01"
            value={settings.MIN_BASE_TOKEN_RESERVE}
            onChange={e => setSettings({...settings, MIN_BASE_TOKEN_RESERVE: e.target.value})}
          />
        </label>
        <label>
          Max Gas Price (Gwei):
          <input
            type="number"
            value={settings.MAX_GAS_PRICE}
            onChange={e => setSettings({...settings, MAX_GAS_PRICE: e.target.value})}
          />
        </label>
        <label>
          Token Whitelist (comma-separated):
          <input
            type="text"
            value={settings.TOKEN_WHITELIST}
            onChange={e => setSettings({...settings, TOKEN_WHITELIST: e.target.value})}
          />
        </label>
        <label>
          Token Blacklist (comma-separated):
          <input
            type="text"
            value={settings.TOKEN_BLACKLIST}
            onChange={e => setSettings({...settings, TOKEN_BLACKLIST: e.target.value})}
          />
        </label>
        <label>
          Flashbots Enabled:
          <input
            type="checkbox"
            checked={settings.FLASHBOTS_ENABLED}
            onChange={e => setSettings({...settings, FLASHBOTS_ENABLED: e.target.checked})}
          />
        </label>
        <button type="button" onClick={updateSettingsHandler} disabled={loading}>
          {loading ? 'Updating...' : 'Update Settings'}
        </button>
      </form>
    </div>
  );
};

export default Settings;
