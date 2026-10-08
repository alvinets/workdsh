import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
// feature.directory is repo-root relative ("packages/plugins/skills"), so it
// must resolve from the repository root, not from this workspace. install-preview
// already joins the same directories as '../../packages/...'.
const repoRoot=new URL('../../../',import.meta.url);
export async function sharedProfileFeatures(){
 const plan=JSON.parse(await readFile(new URL('../../profiles/shared/workdsh-features.json',root),'utf8'));
 const names=new Set();
 for(const feature of plan.features){
  if(names.has(feature.name))throw Error('Duplicate shared feature '+feature.name);
  names.add(feature.name);
  const manifest=JSON.parse(await readFile(new URL(feature.directory+'/package.json',repoRoot),'utf8'));
  if(manifest.name!==feature.name)throw Error('Shared feature package mismatch '+feature.name);
 }
 return plan;
}
