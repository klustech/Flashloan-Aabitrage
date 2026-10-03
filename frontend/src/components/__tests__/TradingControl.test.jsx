import React from 'react';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import TradingControl from '../TradingControl';
import {API} from '../../services/api';
jest.mock('../../services/api',()=>({API:{get:jest.fn(),post:jest.fn()}}));
test('shows measured scan latency and cached block without enabling live trading',async()=>{
  API.get.mockResolvedValue({data:{trading:{state:'PAPER'},summary:{pending:0},executions:[],latency:{durationMs:240,cache:{block:123,pools:40,logFallbacks:0},screened:12,sized:1,transactionCalls:2,screeningBatches:3,screeningPassed:1,screeningStopReason:'candidate_cap',candidates:{profitableMarginal:443}},scanner:{source:'websocket+http'}}});
  render(<TradingControl/>);
  expect(await screen.findByText(/Last scan: 240 ms/)).toHaveTextContent('Block 123');
  expect(screen.getByText(/Cached pools: 40/)).toHaveTextContent('Transaction simulations: 2');
  expect(screen.getByText(/Screening batches: 3/)).toHaveTextContent('Marginal candidates: 443');
  expect(screen.getByText(/Screening batches: 3/)).toHaveTextContent('Pool log fallbacks: 0');
  expect(screen.getByText(/Screening limit reached/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'GO LIVE'})).toBeDisabled();
});
test('PAPER does not enable GO LIVE without backend arming',async()=>{
  API.get.mockResolvedValue({data:{trading:{state:'PAPER'},summary:{pending:0},executions:[]}});
  render(<TradingControl/>);
  expect(await screen.findByText(/No trade signing or submission/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'GO LIVE'})).toBeDisabled();
});
test('backend readiness rejection is displayed and GO LIVE stays disabled',async()=>{
  API.get.mockResolvedValue({data:{trading:{state:'PAPER'},summary:{pending:0},executions:[]}});
  API.post.mockRejectedValue({response:{data:{error:'Seven-day paper burn-in incomplete'}}});
  render(<TradingControl/>);await screen.findByText(/No trade signing or submission/);
  fireEvent.click(screen.getByRole('button',{name:'Arm live trading'}));
  await waitFor(()=>expect(screen.getByText('Seven-day paper burn-in incomplete')).toBeInTheDocument());
  expect(API.post).toHaveBeenCalledWith('/api/trading/arm');
  expect(screen.getByRole('button',{name:'GO LIVE'})).toBeDisabled();
});
