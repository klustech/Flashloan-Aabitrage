// src/components/Navbar.js

import React from 'react';
import { NavLink } from 'react-router-dom';
import './Navbar.css';

const Navbar = () => {
  return (
    <nav className="navbar">
      <NavLink to="/" end activeclassname="active">
        Dashboard
      </NavLink>
      <NavLink to="/trades" activeclassname="active">
        Trades
      </NavLink>
      <NavLink to="/settings" activeclassname="active">
        Settings
      </NavLink>
      <NavLink to="/logs" activeclassname="active">
        Logs
      </NavLink>
    </nav>
  );
};

export default Navbar;
