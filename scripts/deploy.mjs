
import chalk from 'chalk';
import * as path from 'path';
import ora from 'ora';
import prompts from 'prompts';
import { exec } from 'child_process';
// import * as archiver from 'archiver';
import * as fs from 'fs';
import { Client } from 'ssh2';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const nestConfig = require("../nest-cli.json");

const __dirname = process.cwd();
const log = console.log;
const rootPath = __dirname;
const scriptPath = `${__dirname}/scripts/scripts`;
const buildPath = `${__dirname}/dist/apps`;
// const services = nestConfig.microservices;
const services = Object.keys(nestConfig.projects);
let data = {};

const logger = {
  error: chalk.bold.red,
  warning: chalk.bold.yellow,
  info: chalk.bold.white,
  success: chalk.bold.green,
  key: chalk.grey,
  value: chalk.italic.white,
};

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

const readAvailableEnvs = () => {
  var envs = fs.readdirSync(scriptPath).filter((fn) => fn.endsWith('.config.js'));
  envs = envs.map((e) => {
    const env = e.split('.')[0];
    return { title: env.toUpperCase(), value: e };
  });
  return envs;
};


const buildAService = (serviceName) => {
  return new Promise((resolve, reject) => {
    const spinner = ora(logger.info(`executing script: nest build ${serviceName}`)).start();
    exec(`nest build ${serviceName}`, async (err, stdout, stderr) => {
      spinner.clear();
      if (err) {
        spinner.fail();
        log(logger.error(stdout));
        reject(`Build Error: Error Building`);
      } else {
        spinner.succeed();
        resolve();
      }
    });
  });
}

const uploadAService = (serviceName) => {
  return new Promise((resolve, reject) => {
    const { configs } = data;
    const spinner = ora(
      logger.info(
        `Uploading ${serviceName} to ${configs.username}@${configs.host}:${configs.rootDirectoryPath}/${serviceName}`,
      ),
    ).start();
    const servicePath = `${buildPath}/${serviceName}`;
    return exec(
      `scp -i "${scriptPath}/scripts/pems/${configs.pemFileName}" -r "${servicePath}" ${configs.username}@${configs.host}:"${configs.rootDirectoryPath}"`,
      async (err, stdout, stderr) => {
        spinner.clear();
        if (err) {
          console.log(err);
          spinner.fail();
          log(logger.error(stdout));
          reject(`Error Uploading`);
        } else {
          spinner.succeed();
          resolve();
        }
      },
    );
  });
}


const uploadBuild = async () => {
  return new Promise(async (resolve, reject) => {
    try {
      const { confirmProceed } = await prompts([
        {
          type: 'confirm',
          name: 'confirmProceed',
          message: 'Please confirm',
          initial: true,
        },
      ]);
      if (!confirmProceed) {
        reject('User Rejected upload.');
      }
      await asyncForEach(services, async (service, index) => {
        await uploadAService(service)
      });
    } catch (e) { }
  })
}

const buildSource = async () => {

  return new Promise(async (resolve, reject) => {
    log(logger.info('Build Processing...\n'));
    await exec(`npm run prebuild`, async (err, stdout) => {
      if (err) {
        log(logger.error(stdout));
        reject(`Build Error: Error Building`);
      }
      await asyncForEach(services, async (service, index) => {
        await buildAService(service)
      });
      resolve();
    });
  });
}



const addConfigFileToAService = (serviceName) => {
  return new Promise((resolve, reject) => {
    exec(`cp ./package.json ${buildPath}/${serviceName}`, async (err, stdout, stderr) => {
      if (err) {
        log(logger.error(stdout));
        reject(`Build Error: Error in moving config files to build folder`);
      } else {
        resolve();
      }
    });
  });
}

const addConfigFiles = async () => {
  return new Promise(async (resolve, reject) => {
    log(logger.info('Pushing Package.json file to the build folder.\n'));
    await asyncForEach(services, async (service, index) => {
      await addConfigFileToAService(service)
    });
    resolve();
  });
}

const executeCommand = (conn, cmd) => {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) throw err;
      stream
        .on('data', (data) => {
          return resolve(data)
        })
        .stderr.on('data', (data) => {
          return reject(data)
        });
    });

  });
}

const executeRemoteCommands = () => {
  return new Promise(async (resolve, reject) => {
    var conn = new Client();
    const config = data.configs;
    conn
      .on('ready', async () => {
        console.log(`SSH'ed into ${config.username}@${config.host}`);
        await asyncForEach(services, async (service) => {
          let cmd = `cd ${rootDirectoryPath}/${service} && npm install`;
          const res = await executeCommand(conn, cmd);
          console.log(res);
        });
        conn.destroy()
      }).on("error", (error) => {
        console.log(error)
        return reject(error)
      })
      .on("close", () => {
        return resolve()
      })
      .connect({
        host: config.host,
        username: config.username,
        port: 22,
        privateKey: fs.readFileSync(
          `${scriptPath}/pems/${config.pemFileName}`,
        ),
        debug: (s) => { console.log(s) }
      });
  })
};

const main = async () => {
  try {
    const availableEnvs = readAvailableEnvs();
    if (availableEnvs.length === 0) {
      log(logger.error('No Env Conf found to deploy.'));
      return;
    }
    const { env } = await prompts([
      {
        type: 'select',
        name: 'env',
        message: 'Please choose the environment to deploy?',
        choices: availableEnvs,
        initial: 0,
      },
    ]);
    // Environment configuration for the reference.
    const configs = await import(`${scriptPath}/${env}`);
    data = {
      ...data,
      env,
      configs: configs.default,
    };
    log(`\n`);
    log(logger.info('Choosed configuration:\n'));
    log(logger.info(JSON.stringify(data, undefined, 4)));
    log(`\n`);
    const { confirmProceed } = await prompts([
      {
        type: 'confirm',
        name: 'confirmProceed',
        message: 'Please confirm',
        initial: true,
      },
    ]);
    log(`\n`);
    if (confirmProceed) {
      //Build the Source code.
      await buildSource();
      console.log('Build Success');
      //Upload Package JSON.
      await addConfigFiles();
      console.log('Added config files to the build folder');

      //Upload build folder and upload
      await uploadBuild();

      // //Ssh and Execute Remote Commands.
      await executeRemoteCommands();
    } else {
      log(logger.error('Deployment aborted by user.'));
    }
  } catch (e) {
    console.log(e)
  }
};

main();
