const { spawn } = require('child_process');

// Store content in agentzero memory
const memoryStore = (key, content, category) => {
  return new Promise((resolve, reject) => {
    const proc = spawn('agentzero', ['memory', 'store', key, '--category', category, '--', content]);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agentzero exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => reject(err));
  });
};

module.exports = { memoryStore };
