const { Contract, utils } = require('ethers');
const { address, integer } = require('../bot/units');
const ABI = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
class TokenRegistry {
  constructor(provider, chainId) { this.provider=provider; this.chainId=chainId; this.tokens=new Map(); }
  register(record) {
    const token=Object.freeze({...record,address:address(record.address),chainId:this.chainId,decimals:integer(record.decimals,'token decimals',0,36)});
    this.tokens.set(token.address,token); return token;
  }
  async load(configuredTokens, blockTag) {
    for (const [symbol,addr] of Object.entries(configuredTokens)) {
      const contract=new Contract(address(addr),ABI,this.provider);
      const decimals=await contract.decimals({blockTag});
      this.register({address:addr,symbol,decimals});
    }
    return this;
  }
  get(addr) { const token=this.tokens.get(address(addr)); if (!token) throw new Error(`Missing token metadata ${addr}`); return token; }
  parse(addr,value) { return utils.parseUnits(String(value),this.get(addr).decimals); }
  format(addr,value) { return utils.formatUnits(value,this.get(addr).decimals); }
}
module.exports={TokenRegistry};
