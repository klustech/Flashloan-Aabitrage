import {render,screen} from "@testing-library/react";
import BackrunPanel from "../BackrunPanel";
import {useTradingStatus} from "../../hooks/useTradingStatus";
jest.mock("../../hooks/useTradingStatus",()=>({useTradingStatus:jest.fn()}));
test("empty observer is honest about missing flow and never invents profitable bundles",()=>{
  useTradingStatus.mockReturnValue({status:{safety:{paperOnly:true},backrun:{enabled:false},profile:{backrun:{orderflowSource:"disabled"}}}});
  render(<BackrunPanel/>);
  expect(screen.getByText("Waiting for tracked order flow")).toBeInTheDocument();
  expect(screen.getByText(/PAPER-only: no transaction signatures/)).toBeInTheDocument();
  expect(screen.getByText("Disabled")).toBeInTheDocument();
});
test("observer preserves settlement-token decimals and distinguishes unsigned fork evidence from relay proof",()=>{
  useTradingStatus.mockReturnValue({status:{safety:{paperOnly:true},profile:{backrun:{fundingMode:"adaptive",borrowSymbols:["WETH","DAI","USDC"],capitalReserveBps:1000}},
    backrun:{enabled:true,running:true,source:{connected:true},received:3,decoded:2,simulations:1,profitable:1,activity:{signatures:0,submissions:0},
      recent:[{id:"a",triggerHash:"0x"+"01".repeat(32),triggerSource:"custom",status:"SIMULATED",parentBlock:10,targetBlock:11,
        fundingMode:"CAPITAL",token:{symbol:"USDC",decimals:6},funding:{capitalAvailable:"2000000",protectedReserveBps:1000},
        flashPremium:"1000",economics:{expectedNetProfit:"1234567"},simulation:{relaySimulation:false}}]}}});
  render(<BackrunPanel/>);
  expect(screen.getByText("Unsigned fork")).toBeInTheDocument();
  expect(screen.getAllByText("1.234567 USDC")).toHaveLength(2);
  expect(screen.getByText("Observing")).toBeInTheDocument();
  expect(screen.queryByText("Private relay")).not.toBeInTheDocument();
});
