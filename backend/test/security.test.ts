import {describe,it,expect} from 'vitest';
function needsShield(night:boolean,large:boolean,amount:number,threshold=5000000){return {night:night,large:large&&amount>=threshold,required:(night&&night)||(large&&amount>=threshold)}}
describe('transaction protection',()=>{it('blocks large transactions when shield is enabled',()=>expect(needsShield(false,true,5000000).required).toBe(true));it('allows normal daytime transactions',()=>expect(needsShield(false,true,4999999).required).toBe(false));it('blocks night transactions',()=>expect(needsShield(true,false,100).required).toBe(true))});
