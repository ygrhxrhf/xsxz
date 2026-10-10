import http from 'node:http'
const server=http.createServer(async(req,res)=>{
 let body=''; for await(const c of req) body+=c
 const parsed=JSON.parse(body||'{}'); const prompt=parsed.messages?.map(x=>x.content).join('\n')||''
 let content='好'
 if(prompt.includes('reviewDecisions')) content=JSON.stringify({characters:[],relations:[],foreshadows:[],events:[],reviewDecisions:[{itemId:'character-1111111111111111',confirmed:true}]})
 else if(prompt.includes('corePhrase')) content=JSON.stringify({corePhrase:'账册',keywords:['码头','旧仓库']})
 else if(prompt.includes('"evidence"')) content=JSON.stringify({answer:'顾清在旧仓库旁发现账册。',citations:['qa-c0001-p1']})
 else if(prompt.includes('前情')) content='顾清在码头附近发现旧账册，并开始调查林家的秘密往来。'
 const payload={choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,prompt_cache_hit_tokens:2}}
 const send=()=>{res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(payload))}; if(prompt.includes('reviewDecisions')) setTimeout(send,5000); else send()
})
server.listen(18080,'127.0.0.1',()=>console.log('mock-ai-ready'))
