import React from 'react';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import TradingControl from '../TradingControl';
import {API} from '../../services/api';
jest.mock('../../services/api',()=>({API:{get:jest.fn(),post:jest.fn()}}));
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
