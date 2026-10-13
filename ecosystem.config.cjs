const path=require('path');
module.exports={apps:[{
 name:'baronbet',script:'server.js',cwd:__dirname,
 exec_mode:'fork',instances:1,autorestart:true,
 env:{NODE_ENV:'production',PORT:3000,DB_FILE:process.env.DB_FILE||'/var/lib/baronbet/sportsbook.db'}
}]};
