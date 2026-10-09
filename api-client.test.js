const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readJson,ApiResponseError}=require('./public/api-client');

test('JSON objects, arrays and API errors retain their response contract',async()=>{
  for(const [body,status] of [[{bet:{id:13}},200],[[{id:1}],200],[{error:'Permission denied.'},403]]){
    assert.deepEqual(await readJson(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8'}})),body);
  }
});
test('HTML, malformed JSON and invalid payloads produce safe actionable errors',async()=>{
  for(const [body,status,type] of [['<!DOCTYPE html><h1>Not found</h1>',404,'text/html'],['<html>Proxy error</html>',502,'text/html'],['<html>Login</html>',200,'text/html'],['{broken',200,'application/json'],['',200,'application/json'],['null',200,'application/json']]){
    await assert.rejects(()=>readJson(new Response(body,{status,headers:{'Content-Type':type}})),error=>{
      assert(error instanceof ApiResponseError);assert.equal(error.status,status);assert.equal(error.code,'INVALID_API_RESPONSE');
      assert(!/Unexpected token|DOCTYPE|<html>|SyntaxError/.test(error.message));return true;
    });
  }
});
