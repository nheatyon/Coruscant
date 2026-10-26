import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { ContextProvider } from './lib/context.js';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(<BrowserRouter><ContextProvider><App /></ContextProvider></BrowserRouter>);
