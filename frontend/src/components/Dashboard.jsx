import React from "react";

const Dashboard = () => {
  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-xl font-semibold">Total Profit</h2>
          <p className="text-3xl font-bold mt-2">$0.00</p>
        </div>
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-xl font-semibold">Open Positions</h2>
          <p className="text-3xl font-bold mt-2">0</p>
        </div>
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-xl font-semibold">Execution Time</h2>
          <p className="text-3xl font-bold mt-2">0 ms</p>
        </div>
      </div>
      <div className="mt-8">
        <h2 className="text-xl font-semibold mb-2">Recent Trades</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white shadow rounded-lg">
            <thead>
              <tr>
                <th className="py-2 px-4 border-b">Time</th>
                <th className="py-2 px-4 border-b">Asset</th>
                <th className="py-2 px-4 border-b">Profit</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-2 px-4 border-b">12:00</td>
                <td className="py-2 px-4 border-b">ETH/BTC</td>
                <td className="py-2 px-4 border-b">$123.45</td>
              </tr>
              {/* Additional rows rendered dynamically */}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
