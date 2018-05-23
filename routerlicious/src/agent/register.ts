import { api, core } from "../client-api";
import { IDocumentServiceFactory } from "./definitions";
import { WorkerService } from "./workerService";
import { WorkManager } from "./workManager";

class DefaultDocumentServiceFactory implements IDocumentServiceFactory {
    public getService(tenantId: string): Promise<core.IDocumentService> {
        return Promise.resolve(api.getDefaultDocumentService());
    }
}

export function registerWorker(config: any, runnerType: string) {
    if (!config.onlyServer) {
        const workerUrl =  config.url;
        const serverUrl = config.serverUrl;

        // Bootstrap service and connect. On failure, try to connect again.
        console.log(`Registering as worker`);

        const workTypeMap: { [workType: string]: boolean} = {};
        for (const workType of config.permission[runnerType]) {
            workTypeMap[workType] = true;
        }

        const workManager = new WorkManager(
            new DefaultDocumentServiceFactory(),
            config,
            serverUrl,
            initLoadModule(config),
            runnerType,
            workTypeMap);

        const workerService = new WorkerService(
            workerUrl,
            config,
            workTypeMap,
            workManager);

        // Report any service error.
        workerService.on("error", (error) => {
            console.log(error);
        });

        let workerP = workerService.connect("Client");
        workerP.catch((error) => {
            console.log(`Error connecting to worker`);
            workerP = workerService.connect("Client");
        });
    }
}

function initLoadModule(config: any): (name: string) => Promise<any> {
    return (scriptName: string) => {
        return new Promise<any>((resolve, reject) => {
            /*
            const scriptUrl = `${config.scriptUrl}${scriptName}`;
            $.getScript(scriptUrl, (data, textStatus, jqxhr) => {
                console.log(data);
                console.log(textStatus);
                console.log(jqxhr.status);
                console.log("Load was performed.");

                const m1 = "ResumeAnalyticsFactory";
                const m2 = "factory";
                import(m1).then((loadedModule) => {
                    console.log(`${loadedModule}`);
                }, (err) => {
                    console.log(`Error importing ${scriptName}: ${err}`);
                });

                import(m2).then((loadedModule) => {
                    console.log(`${loadedModule}`);
                }, (err) => {
                    console.log(`Error importing ${scriptName}: ${err}`);
                });
              });
            */
            reject("Client module loader not implemented yet");
        });
    };
}
