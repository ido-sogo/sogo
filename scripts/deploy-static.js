'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { createClient } = require('@supabase/supabase-js');

const root = path.resolve(__dirname, '..');
const bucketName = 'sogo-site';
const assets = [
    { name: 'index.html', contentType: 'text/html; charset=utf-8' },
    { name: 'script.js', contentType: 'text/javascript; charset=utf-8' },
    { name: 'style.css', contentType: 'text/css; charset=utf-8' }
];

loadEnvironment();

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env before deploying.');
}

async function deploy() {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
        throw listError;
    }

    const bucket = buckets.find((item) => item.name === bucketName);
    if (!bucket) {
        const { error } = await supabase.storage.createBucket(bucketName, { public: true });
        if (error) {
            throw error;
        }
    } else if (!bucket.public) {
        const { error } = await supabase.storage.updateBucket(bucketName, { public: true });
        if (error) {
            throw error;
        }
    }

    for (const asset of assets) {
        const content = await fs.readFile(path.join(root, asset.name));
        const { error } = await supabase.storage.from(bucketName).upload(asset.name, content, {
            cacheControl: '0',
            contentType: asset.contentType,
            upsert: true
        });
        if (error) {
            throw error;
        }
    }

    console.log('Static assets uploaded to Supabase Storage.');
}

function loadEnvironment() {
    const filePath = path.join(root, '.env');
    let contents;
    try {
        contents = readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || match[1] in process.env) {
            continue;
        }
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
    }
}

deploy().catch((error) => {
    console.error('Supabase static deployment failed:', error.message);
    process.exitCode = 1;
});
