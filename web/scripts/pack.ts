import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const args = process.argv.slice(2);
let scenariosDir = '';
let outputPath = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' && args[i + 1]) {
    outputPath = args[i + 1];
    i++;
  } else if (!scenariosDir) {
    scenariosDir = args[i];
  }
}

if (!scenariosDir || !outputPath) {
  console.error('Usage: npm run pack -- <scenarios-dir> -o <output.litmus-pack>');
  process.exit(1);
}

const scenariosPath = path.resolve(scenariosDir);
const dirs = fs.readdirSync(scenariosPath, { withFileTypes: true })
  .filter((d) => d.isDirectory());

interface ManifestScenario {
  slug: string;
  name: string;
  description: string;
  language: string;
  tags: string[];
  maxScore: number;
}

const manifest: { version: string; scenarios: ManifestScenario[] } = {
  version: '1',
  scenarios: [],
};

const zip = new AdmZip();

for (const dir of dirs) {
  const slug = dir.name;
  const scenarioPath = path.join(scenariosPath, slug);

  const hasTestPy = fs.existsSync(path.join(scenarioPath, 'test.py'));
  const language = hasTestPy ? 'python' : 'python';

  const promptPath = path.join(scenarioPath, 'prompt.txt');
  const promptText = fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, 'utf-8')
    : '';
  const name = slug.replace(/^\d+-/, '').replace(/-/g, ' ');

  manifest.scenarios.push({
    slug,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    description: promptText.split('\n')[0].slice(0, 200),
    language,
    tags: [],
    maxScore: 100,
  });

  addDirToZip(zip, scenarioPath, slug);
}

zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
zip.writeZip(path.resolve(outputPath));
console.log(`Packed ${manifest.scenarios.length} scenarios -> ${outputPath}`);

function addDirToZip(z: AdmZip, dirPath: string, zipPrefix: string): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      addDirToZip(z, fullPath, zipPath);
    } else {
      z.addFile(zipPath, fs.readFileSync(fullPath));
    }
  }
}
