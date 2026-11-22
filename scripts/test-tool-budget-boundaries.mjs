import assert from 'node:assert/strict';
import { formatBudgetExhaustedNotice, runWithInjectedTools } from '../dist/tools/strategies.js';

const failures=[];
for(const [name, run] of [
  ['额度提示不回显命令、查询或提问正文',async()=>{
    const marker='REVIEW_ONLY_SECRET';
    const notice=formatBudgetExhaustedNotice({
      totalCalls:1,maxToolRounds:1,
      lastExecutedTool:{name:'shell_run',args:{command:'echo '+marker},ok:true},
      nextPendingTool:{name:'mcp__service__search',args:{query:marker,question:marker}},
    });
    assert(!notice.includes(marker),'进度提示不得携带命令或查询正文');
    assert(notice.includes('shell_run')&&notice.includes('mcp__service__search'));
    const files=formatBudgetExhaustedNotice({totalCalls:1,maxToolRounds:1,
      lastExecutedTool:{name:'file_write',args:{path:'result.md',content:marker},ok:false},
      nextPendingTool:{name:'file_read',args:{path:'README.md'}},
    });
    assert(files.includes('result.md')&&files.includes('README.md')&&files.includes('失败'));
    assert(!files.includes(marker));
  }],
  ['额度通知异步发送期间取消仍优先于超限状态',async()=>{
    const controller=new AbortController();
    let calls=0;
    const result=await runWithInjectedTools({
      userText:'读取两个文件',tools:[],workspaceRoot:process.cwd(),maxToolRounds:1,
      abortSignal:controller.signal,
      turn:async()=>({text:'```quick-tool-call\n'+JSON.stringify([
        {name:'file_read',arguments:{path:'one.md'}},
        {name:'file_read',arguments:{path:'two.md'}},
      ])+'\n```',cancelled:false}),
      executor:{execute:async()=>{calls++;return{ok:true,content:'内容'};}},
      onAssistantText:()=>{},onToolCall:()=>{},
      onBudgetExhausted:async()=>{await Promise.resolve();controller.abort();},
    });
    assert.equal(calls,1,'取消后不得执行第二个工具');
    assert.equal(result.cancelled,true,'通知期间发生取消时必须返回取消');
    assert.equal(result.exhausted,false,'取消优先，不返回额度耗尽状态');
  }],
]){
  try{await run();console.log('PASS '+name);}catch(error){failures.push(error);console.error('FAIL '+name+': '+error.message);}
}
if(failures.length)throw new AggregateError(failures,'工具预算边界回归失败');
console.log('2项工具预算边界回归通过');
