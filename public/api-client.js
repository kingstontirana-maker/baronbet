'use strict';

// Shared response boundary for the sportsbook, staff workspace and legacy page.
(function(root){
  class ApiResponseError extends Error {
    constructor(message,response,code){super(message);this.name='ApiResponseError';this.status=response.status;this.code=code;}
  }
  async function readJson(response){
    const contentType=response.headers.get('content-type')||'';
    const unexpected=()=>new ApiResponseError(
      response.status===404?'Shërbimi i kërkuar nuk u gjet. Rifreskoni faqen ose kontaktoni administratorin.':
      response.status===401?'Sesioni ka skaduar. Hyni përsëri në llogari.':
      response.status>=500?'Shërbimi është përkohësisht i padisponueshëm. Provoni përsëri.':
      'Serveri ktheu një përgjigje të pavlefshme. Provoni përsëri ose kontaktoni administratorin.',
      response,'INVALID_API_RESPONSE');
    if(!/^application\/(?:[\w.-]+\+)?json(?:\s*;|\s*$)/i.test(contentType))throw unexpected();
    const text=await response.text();
    try{const data=JSON.parse(text);if(data===null||typeof data!=='object')throw unexpected();return data;}
    catch(error){if(error instanceof ApiResponseError)throw error;throw unexpected();}
  }
  const api={readJson,ApiResponseError};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.SportsbookApi=Object.freeze(api);
})(globalThis);
