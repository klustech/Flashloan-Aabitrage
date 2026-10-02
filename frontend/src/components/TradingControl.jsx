import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import { API } from '../services/api';
function formatUnits(value, decimals = 18) {
  if(value===undefined||value===null)return '—';
  const raw=String(value),negative=raw.startsWith('-'),digits=(negative?raw.slice(1):raw).padStart(decimals+1,'0');
  if(decimals===0)return raw;
  const whole=digits.slice(0,-decimals),fraction=digits.slice(-decimals).slice(0,6).replace(/0+$/,'');
  return `${negative?'-':''}${whole}${fraction?'.'+fraction:''}`;
}
export default function TradingControl(){
  const [status,setStatus]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState(null);
  const refresh=async()=>{try{setStatus((await API.get('/api/trading')).data);}catch(e){setError(e.response?.data?.error||e.message);}};
  useEffect(()=>{refresh();const timer=setInterval(refresh,15000);return()=>clearInterval(timer);},[]);
  const action=async name=>{setBusy(true);setError('');try{await API.post(`/api/trading/${name}`);await refresh();}catch(e){setError(e.response?.data?.error||e.message);}finally{setBusy(false);}};
  const state=status?.trading?.state||'UNAVAILABLE',live=state==='LIVE_RUNNING';
  const records=status?.executions||[];
  const record=records.find(r=>r.id===selected)||records.find(r=>r.economics);
  const unit=record?.token?.symbol||'token',decimals=record?.token?.decimals;
  return <Paper sx={{p:2,mb:3}}>
    <Box sx={{display:'flex',gap:2,alignItems:'center',flexWrap:'wrap',mb:2}}>
      <Typography variant="h6">Trading controls</Typography><Chip color={live?'error':'info'} label={state}/>
      <Button disabled={busy} onClick={()=>action('paper')}>PAPER</Button>
      <Button disabled={busy||state!=='PAPER'} onClick={()=>action('arm')}>Arm live trading</Button>
      <Button color="error" variant="contained" disabled={busy||state!=='LIVE_ARMED'} onClick={()=>action('live')}>GO LIVE</Button>
      <Button color="warning" disabled={busy} onClick={()=>action('pause')}>Emergency pause</Button>
    </Box>
    {live&&<Alert severity="error">LIVE MODE — REAL FUNDS. Transactions are signed and submitted privately.</Alert>}
    {state==='PAPER'&&<Alert severity="info">PAPER: scanning and on-chain simulation. No trade signing or submission.</Alert>}
    {error&&<Alert severity="error" sx={{mt:1}}>{error}</Alert>}
    {status?.trading?.reason&&<Alert severity="warning" sx={{mt:1}}>{status.trading.reason}</Alert>}
    <Typography variant="body2" sx={{mt:2}}>Ethereum · Aave V2 · Two-pool and three-leg routes · {status?.busy?'Validating opportunity':'Waiting for next scan'} · Pending receipts: {status?.summary?.pending||0}</Typography>
    <Box sx={{display:'flex',gap:3,flexWrap:'wrap',my:2}}>
      {Object.values(status?.summary?.tokens||{}).map(group=><Box key={group.borrowToken}>
        <Typography>Realized net: {formatUnits(group.realizedNet,group.token?.decimals)} {group.token?.symbol}</Typography>
        <Typography color="text.secondary">Paper expected net: {formatUnits(group.expectedPaperNet,group.token?.decimals)} {group.token?.symbol}</Typography>
        <Typography color="text.secondary">Actual gas: {formatUnits(group.realizedGasNative)} ETH</Typography>
      </Box>)}
    </Box>
    {status?.readiness&&!status.readiness.ready&&<Alert severity="warning">Live trading remains unavailable: {status.readiness.errors.join('; ')}</Alert>}
    <Table size="small"><TableHead><TableRow><TableCell>Mode / status</TableCell><TableCell>Exact route and pools</TableCell><TableCell>Expected net</TableCell><TableCell>Realized net</TableCell><TableCell>Result</TableCell></TableRow></TableHead>
      <TableBody>{records.slice(0,15).map(r=><TableRow key={r.id} hover onClick={()=>setSelected(r.id)} sx={{cursor:'pointer'}}><TableCell>{r.mode} / {r.status}</TableCell>
        <TableCell>{r.route?.legs?.map(l=>`${l.dex} ${l.poolAddress}`).join(' → ')||r.candidateId}</TableCell>
        <TableCell>{formatUnits(r.economics?.expectedNetProfit,r.token?.decimals)} {r.token?.symbol}</TableCell><TableCell>{formatUnits(r.realizedNetProfit,r.token?.decimals)} {r.token?.symbol}</TableCell>
        <TableCell>{r.txHash?<a href={`https://etherscan.io/tx/${r.txHash}`} target="_blank" rel="noreferrer">Transaction</a>:r.reason||'Simulation passed'}</TableCell></TableRow>)}</TableBody></Table>
    {record?.economics&&<Box sx={{mt:2}}>
      <Typography variant="h6">Execution details</Typography>
      {['borrowAmount','expectedFinalAmount','flashloanFee','estimatedGasCostBorrowToken','estimatedBuilderPaymentBorrowToken','expectedNetProfit'].map(key=><Typography key={key}>{key.replace(/([A-Z])/g,' $1')}: {formatUnits(record.economics[key],decimals)} {unit}</Typography>)}
      <Typography>Simulation: {record.simulation?.callStatic?'On-chain PASS':'Pending'} · Bundle: {record.simulation?.bundle?'PASS':record.mode==='PAPER'?'Unsigned PAPER — not run':'Pending'}</Typography>
      <Typography>Quote block: {record.stateBlock} · Strategy: {record.route?.strategy}</Typography>
      {status.summary?.accuracy?.[record.borrowToken]&&<Typography>Prediction error — mean {formatUnits(status.summary.accuracy[record.borrowToken].mean,decimals)}, median {formatUnits(status.summary.accuracy[record.borrowToken].median,decimals)}, p95 {formatUnits(status.summary.accuracy[record.borrowToken].p95,decimals)} {unit}</Typography>}
    </Box>}
  </Paper>;
}
