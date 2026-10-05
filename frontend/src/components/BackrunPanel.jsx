import React from "react";
import { Alert, Box, Chip, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { useTradingStatus } from "../hooks/useTradingStatus";
import { Panel, Metric, EmptyState } from "../ui/Primitives";
import { number, formatUnits, time } from "../ui/format";
export default function BackrunPanel() {
  const { status } = useTradingStatus();
  const backrun = status?.backrun, config = status?.profile?.backrun, rows = backrun?.recent || [];
  const latest = rows.find(r => r.funding), source = backrun?.source, engine = backrun?.engine;
  return <Box sx={{ display: "grid", gap: 3 }}>
    <Alert severity={backrun?.circuitReason ? "warning" : "info"}>
      {status?.safety?.paperOnly ? "PAPER-only: no transaction signatures or submissions." : "LIVE remains subject to commissioning and private bundle simulation."}
      {" "}Unsigned fork bundle tests and private relay simulations are recorded separately.
    </Alert>
    <Panel title="Transaction-triggered observation" subtitle="Ephemeral post-trigger state, independent of the confirmed-block scanner."
      action={<Chip label={!backrun?.enabled ? "Disabled" : source?.connected && backrun.running ? "Observing" : "Disconnected"} variant="outlined" />}>
      <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        <Typography variant="body2">Source: {backrun?.orderflowSource || config?.orderflowSource || "disabled"}</Typography>
        <Typography variant="body2">Last trigger: {time(backrun?.lastTriggerAt)}</Typography>
        <Typography variant="body2">Funding policy: {config?.fundingMode || "adaptive"}</Typography>
        <Typography variant="body2">Priority: {(config?.borrowSymbols || ["WETH", "DAI", "USDC"]).join(" → ")}</Typography>
      </Box>
      {backrun?.circuitReason && <Alert severity="warning" sx={{ mt: 2 }}>{backrun.circuitReason}</Alert>}
      {backrun?.reason && <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{backrun.reason}</Typography>}
    </Panel>
    <Box className="dashboard-grid">
      <Metric label="Triggers received" value={number(backrun?.received)} hint="Current observer process" />
      <Metric label="Ordered fork simulations" value={number(backrun?.simulations)} hint="Unsigned bundle attempts" />
      <Metric label="Profitable fork simulations" value={number(backrun?.profitable)} hint="Verified executor settlement on fork" />
      <Metric label="Decision latency p95" value={number(backrun?.latency?.p95Ms)} unit="ms" hint={"Median "+number(backrun?.latency?.medianMs)+" ms"} />
    </Box>
    <Panel title="Candidate funnel" subtitle="Each stage reflects measured work. Quotes do not establish live profitability.">
      <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {[["Decoded triggers",backrun?.decoded],["Affected routes",engine?.routes],["Exact sizing probes",engine?.evaluated],
          ["Positive gross routes",engine?.grossPositive],["Capital viable",engine?.capitalViable],
          ["Flash viable",engine?.flashViable],["Rejected",backrun?.rejected]].map(([label,value]) =>
          <Box key={label}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="h5">{number(value)}</Typography></Box>)}
      </Box>
    </Panel>
    <Panel title="Funding decision" subtitle="Principal is retained by the executor; funding costs and gas reduce the estimated edge.">
      {!latest ? <EmptyState compact title="No funding decision yet" description="Exact post-trigger candidates appear here when capital or flash liquidity is viable." /> :
        <Box sx={{ display:"grid", gridTemplateColumns:{xs:"1fr",md:"repeat(3,1fr)"},gap:2 }}>
          {[["Selected mode",latest.fundingMode],["Available capital",formatUnits(latest.funding.capitalAvailable,latest.token?.decimals)+" "+(latest.token?.symbol||"")],
            ["Protected reserve",(latest.funding.protectedReserveBps??config?.capitalReserveBps??0)+" bps"],
            ["Flash premium",formatUnits(latest.flashPremium,latest.token?.decimals)+" "+(latest.token?.symbol||"")],
            ["Estimated net",formatUnits(latest.economics?.expectedNetProfit,latest.token?.decimals)+" "+(latest.token?.symbol||"")],
            ["Status",latest.status]].map(([label,value])=><Box key={label}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2">{value}</Typography></Box>)}
        </Box>}
    </Panel>
    <Panel title="Recent triggers & bundles" subtitle="Full raw order flow is omitted from the ledger.">
      {!rows.length ? <EmptyState compact title="Waiting for tracked order flow" description="Start PAPER with a configured source and an isolated fork backend to inspect backrun decisions." /> :
      <TableContainer><Table size="small" aria-label="Backrun decisions">
        <TableHead><TableRow>{["Trigger","Parent → target","Funding","Estimated net","Simulation","Rejection"].map(x=><TableCell key={x}>{x}</TableCell>)}</TableRow></TableHead>
        <TableBody>{rows.map(r=><TableRow key={r.id}>
          <TableCell><Typography variant="body2" className="mono" title={r.triggerHash}>{r.triggerHash?.slice(0,10)}…{r.triggerHash?.slice(-6)}</Typography><Typography variant="caption" color="text.secondary">{r.triggerSource} · {r.status}</Typography></TableCell>
          <TableCell>{r.parentBlock??"—"} → {r.targetBlock??"—"}</TableCell>
          <TableCell>{r.fundingMode||"—"}</TableCell>
          <TableCell>{formatUnits(r.economics?.expectedNetProfit,r.token?.decimals)} {r.token?.symbol||""}</TableCell>
          <TableCell>{r.simulation ? r.simulation.relaySimulation ? "Private relay" : "Unsigned fork" : "—"}</TableCell>
          <TableCell>{r.rejectionReason||"—"}</TableCell>
        </TableRow>)}</TableBody>
      </Table></TableContainer>}
    </Panel>
    <Panel title="Commissioning evidence" subtitle="A healthy observer and isolated-fork results are prerequisites, not proof of competitive capture.">
      <Typography variant="body2">Continuous PAPER: {number(Math.floor((backrun?.burnIn?.continuousMs||0)/3600000))} hours ·
        {" "}Distinct profitable triggers: {number(backrun?.burnIn?.profitable)} ·
        {" "}Signatures: {number(backrun?.activity?.signatures)} · Submissions: {number(backrun?.activity?.submissions)}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        LIVE also requires canonical intra-block replay, at least seven days of historical economics,
        both funding-path fork proofs, current PAPER evidence and an operator risk review.
      </Typography>
      <Box sx={{mt:2,display:"flex",gap:2,flexWrap:"wrap"}}>{Object.entries(backrun?.reasons||{}).map(([reason,count])=><Chip key={reason} size="small" variant="outlined" label={reason+": "+count} />)}</Box>
    </Panel>
  </Box>;
}
