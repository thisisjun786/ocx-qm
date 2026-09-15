// The only browser write changes monitor-owned preferences. Provider files remain read-only.
export function readSelection(req, {timeoutMs = 5000} = {}) {
  return new Promise((resolve,reject) => {
    let bytes=0, chunks=[], finished=false;
    const fail = status => finish(Object.assign(new Error('Invalid subscription body'),{status}));
    const finish = (error,value) => {
      if (finished) return; finished=true;
      clearTimeout(timer); req.off('data',data); req.off('end',end); req.off('error',aborted); req.off('aborted',aborted);
      if (error) {req.resume();reject(error);} else resolve(value);
    };
    const timer = setTimeout(()=>fail(408),timeoutMs);
    const data = chunk => {bytes+=chunk.length;if(bytes>4096)return fail(413);chunks.push(chunk);};
    const end = () => {let body;try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return fail(400);} finish(null,body);};
    const aborted = () => fail(400);
    req.on('data',data);req.on('end',end);req.on('error',aborted);req.on('aborted',aborted);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return fail(415);
    if (Number(req.headers['content-length'])>4096) fail(413);
  });
}
