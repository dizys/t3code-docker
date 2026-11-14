import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {normalize} from '../docker/setup/credentials/model.mjs';
import {logWriter,readLogs} from '../docker/services/logs.mjs';

test('valid existing short credentials remain readable and editable',()=>{
  for(const token of ['abc','sk-one','1234567']){
    const saved=normalize({id:'existing',type:'token',secrets:{token}});
    assert.equal(normalize({...saved,description:'edited'},saved).secrets.token,token);
  }
});

test('service logs redact short and encoded secrets across every split',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-services-redaction-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const secret of ['abc','a','p@ss word','quote"\\line\nnext']){
    const forms=[secret,Buffer.from(secret).toString('base64'),encodeURIComponent(secret),new URLSearchParams([['',secret]]).toString().slice(1),JSON.stringify(secret).slice(1,-1)];
    for(const value of new Set(forms))for(let at=0;at<=value.length;at++){
      const writer=logWriter(root,'test','run','stdout',[secret]);
      writer.write(Buffer.from(value.slice(0,at)));writer.write(Buffer.from(value.slice(at)+'\n'));writer.end();
      assert.equal(readLogs(root,'test').entries.at(-1).text,'[redacted]',`split ${at} for ${JSON.stringify(secret)}`);
    }
  }
});

test('Services imports and masks logs in the installed image directory layout',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-services-image-layout-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.cp(new URL('../docker/services/',import.meta.url),path.join(root,'t3-services'),{recursive:true});
  const setup=path.join(root,'t3-setup','credentials');await fs.mkdir(setup,{recursive:true});
  await fs.copyFile(new URL('../docker/setup/credentials/redact.mjs',import.meta.url),path.join(setup,'redact.mjs'));
  const {logWriter:writer,readLogs:logs}=await import(pathToFileURL(path.join(root,'t3-services','logs.mjs')));
  const output=writer(path.join(root,'logs'),'demo','run','stdout',['private-token']);
  output.write(Buffer.from(Buffer.from('private-token').toString('base64')+'\n'));output.end();
  assert.equal(logs(path.join(root,'logs'),'demo').entries[0].text,'[redacted]');
});
