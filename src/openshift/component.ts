/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-var-requires */

import { ChildProcess, SpawnOptions } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { commands, debug, DebugConfiguration, DebugSession, Disposable, EventEmitter, extensions, ProgressLocation, Terminal, Uri, window, workspace } from 'vscode';
import * as YAML from 'yaml';
import { CliChannel } from '../cli';
import { Command } from '../odo/command';
import { ascDevfileFirst, ComponentTypeAdapter, ComponentTypeDescription } from '../odo/componentType';
import { StarterProject } from '../odo/componentTypeDescription';
import { ComponentWorkspaceFolder } from '../odo/workspace';
import * as odo3 from '../odo3';
import sendTelemetry, { NewComponentCommandProps } from '../telemetry';
import { Progress } from '../util/progress';
import { vsCommand, VsCommandError } from '../vscommand';
import AddServiceBindingViewLoader, { ServiceBindingFormResponse } from '../webview/add-service-binding/addServiceBindingViewLoader';
import CreateComponentLoader from '../webview/create-component/createComponentLoader';
import DescribeViewLoader from '../webview/describe/describeViewLoader';
import LogViewLoader from '../webview/log/LogViewLoader';
import OpenShiftItem, { clusterRequired } from './openshiftItem';

function createCancelledResult(stepName: string): any {
    const cancelledResult: any = new String('');
    cancelledResult.properties = {
        'cancelled_step': stepName
    }
    return cancelledResult;
}

function createStartDebuggerResult(language: string, message = '') {
    const result: any = new String(message);
    result.properties = {
        language
    }
    return result;
}

export enum ComponentContextState {
    DEV = 'dev-nrn',
    DEV_STARTING = 'dev-str',
    DEV_RUNNING = 'dev-run',
    DEV_STOPPING = 'dev-stp',
    DEB = 'deb-nrn',
    DEB_RUNNING = 'deb-run',
    DEP = 'dep-nrn',
    DEP_RUNNING = 'dep-run',
}

export class ComponentStateRegex {
    public static readonly COMPONENT_DEV_STARTING = /openshift\.component\.dev-str.*/;
    public static readonly COMPONENT_DEV_RUNNING = /openshift\.component\.dev-run.*/;
    public static readonly COMPONENT_DEV_STOPPING = /openshift\.component\.dev-stp.*/;
    public static readonly COMPONENT_DEB_STARTING = /openshift\.component.*\.deb-str.*/;
    public static readonly COMPONENT_DEB_RUNNING = /openshift\.component.*\.deb-run.*/;
    public static readonly COMPONENT_DEB_STOPPING = /openshift\.component.*\.deb-stp.*/;
    public static readonly COMPONENT_DEP_STARTING = /openshift\.component.*\.dep-str.*/;
    public static readonly COMPONENT_DEP_RUNNING = /openshift\.component.*\.dep-run.*/;
    public static readonly COMPONENT_DEP_STOPPING = /openshift\.component.*\.dep-stp.*/;
}

interface ComponentDevState {
    // dev state
    devTerminal?: Terminal;
    devProcess?: ChildProcess;
    devStatus?: string;
    contextValue?: string;
    devProcessStopRequest?: DevProcessStopRequest;
    // debug state
    debugStatus?: string;
    // deploy state
    deployStatus?: string;
    runOn?: undefined | 'podman';
}

interface DevProcessStopRequest extends Disposable {
    isSigabrtSent: () => boolean;
    sendSigabrt: () => void;
}

export class Component extends OpenShiftItem {
    private static debugSessions = new Map<string, DebugSession>();
    private static stateChanged = new EventEmitter<string>();

    public static onDidStateChanged(listener: (context: string) => any) {
        Component.stateChanged.event(listener);
    }

    public static init(): Disposable[] {
        return [
            debug.onDidStartDebugSession((session) => {
                if (session.configuration.contextPath) {
                    Component.debugSessions.set(session.configuration.contextPath, session);
                }
            }),
            debug.onDidTerminateDebugSession((session) => {
                if (session.configuration.contextPath) {
                    Component.debugSessions.delete(session.configuration.contextPath);
                }
            })
        ];
    }

    private static readonly componentStates = new Map<string, ComponentDevState>();

    static getComponentDevState(folder: ComponentWorkspaceFolder): ComponentDevState {
        let state = Component.componentStates.get(folder.contextPath);
        if (!state) {
            state = {
                devStatus: folder.component?.devfileData?.supportedOdoFeatures?.dev ? ComponentContextState.DEV : undefined,
                debugStatus: folder.component?.devfileData?.supportedOdoFeatures?.debug ? ComponentContextState.DEB : undefined,
                deployStatus: folder.component?.devfileData?.supportedOdoFeatures?.deploy ? ComponentContextState.DEP : undefined,
            };
            this.componentStates.set(folder.contextPath, state);
        }
        return state;
    }

    public static generateContextValue(folder: ComponentWorkspaceFolder): string {
        const state = Component.componentStates.get(folder.contextPath);
        let contextSuffix = '';
        if (state.devStatus) {
            contextSuffix = contextSuffix.concat('.').concat(state.devStatus);
        }
        if (state.debugStatus) {
            contextSuffix = contextSuffix.concat('.').concat(state.debugStatus);
        }
        if (state.deployStatus) {
            contextSuffix = contextSuffix.concat('.').concat(state.deployStatus);
        }
        return `openshift.component${contextSuffix}`;
    }

    public static renderLabel(folder: ComponentWorkspaceFolder) {
        return `${folder.component.devfileData.devfile.metadata.name}${Component.renderStateLabel(folder)}`
    };

    public static renderStateLabel(folder: ComponentWorkspaceFolder) {
        let label = '';
        const state = Component.getComponentDevState(folder);
        let runningOnSuffix = '';
        if (state.runOn) {
            runningOnSuffix = ` on ${state.runOn}`;
        }
        if (state.devStatus === ComponentContextState.DEV_STARTING) {
            label = ` (dev starting${runningOnSuffix})`;
        } else if(state.devStatus === ComponentContextState.DEV_RUNNING) {
            label = ` (dev running${runningOnSuffix})`;
        } else if(state.devStatus === ComponentContextState.DEV_STOPPING) {
            label = ` (dev stopping${runningOnSuffix})`;
        }
        return label;
    }

    @vsCommand('openshift.component.showDevTerminal')
    static showDevTerminal(context: ComponentWorkspaceFolder) {
        Component.componentStates.get(context.contextPath)?.devTerminal.show();
    }

    static devModeExitTimeout(): number {
        return workspace
            .getConfiguration('openshiftToolkit')
            .get<number>('stopDevModeTimeout');
    }

    private static exitDevelopmentMode(devProcess: ChildProcess) : DevProcessStopRequest {
        let sigAbortSent = false;
        let devCleaningTimeout = setTimeout( () => {
            void window.showWarningMessage('Exiting development mode is taking to long.', 'Keep waiting', 'Force exit')
                .then((action) => {
                    if (!devCleaningTimeout) {
                        void window.showInformationMessage('The warning message has expired and requested action cannot be executed.');
                    } else {
                        if (action === 'Keep waiting') {
                            devCleaningTimeout.refresh();
                        } else if (action === 'Force exit') {
                            sigAbortSent = true;
                            devProcess.kill('SIGABRT');
                        }
                    }
                });
        }, Component.devModeExitTimeout());
        return {
            dispose: () => {
                clearTimeout(devCleaningTimeout);
                devCleaningTimeout = undefined;
            },
            // test devProcess.signalCode approach and switch back to Disposable
            isSigabrtSent: () => sigAbortSent,
            sendSigabrt: () => {
                sigAbortSent = true;
                devProcess.kill('SIGABRT');
            }
        }
    }

    @vsCommand('openshift.component.dev.onPodman')
    static async devOnPodman(component: ComponentWorkspaceFolder) {
        if (await Component.odo.isPodmanPresent()) {
            return Component.devRunOn(component, 'podman');
        }
        void window.showErrorMessage('Podman is not present in the system, please install podman on your machine and try again.', 'Install podman')
            .then(async (result) => {
                if (result === 'Install podman') {
                    await commands.executeCommand('vscode.open', Uri.parse('https://podman.io/'));
                }
            });
        return;
    }

    @vsCommand('openshift.component.binding.add')
    static async addBinding(component: ComponentWorkspaceFolder) {
        const odo: odo3.Odo3 = odo3.newInstance();

        const services = await Progress.execFunctionWithProgress('Looking for bindable services', (progress) => {
            return odo.getBindableServices();
        });

        if (!services || services.length === 0) {
            void window.showErrorMessage('No bindable services are available', 'Open Service Catalog in OpenShift Console')
                .then((result) => {
                    if (result === 'Open Service Catalog in OpenShift Console') {
                        void commands.executeCommand('openshift.open.operatorBackedServiceCatalog')
                    }
                });
            return;
        }

        void sendTelemetry('startAddBindingWizard');

        let formResponse: ServiceBindingFormResponse = undefined;
        try {
            formResponse = await new Promise<ServiceBindingFormResponse>(
                (resolve, reject) => {
                    void AddServiceBindingViewLoader.loadView(
                        component.contextPath,
                        services.map(
                            (service) => `${service.metadata.namespace}/${service.metadata.name}`,
                        ),
                        (panel) => {
                            panel.onDidDispose((_e) => {
                                reject(new Error('The \'Add Service Binding\' wizard was closed'));
                            });
                            return async (eventData) => {
                                if (eventData.action === 'addServiceBinding') {
                                    resolve(eventData.params);
                                    await panel.dispose();
                                }
                            };
                        },
                    ).then(view => {
                        if (!view) {
                            // the view was already created
                            reject();
                        }
                    });
                },
            );
        } catch (e) {
            // The form was closed without submitting,
            // or the form already exists for this component.
            // stop the command.
            return;
        }

        const selectedServiceObject = services.filter(
            (service) =>
                `${service.metadata.namespace}/${service.metadata.name}` === formResponse.selectedService,
        )[0];

        void sendTelemetry('finishAddBindingWizard');

        await odo.addBinding(
            component.contextPath,
            selectedServiceObject.metadata.namespace,
            selectedServiceObject.metadata.name,
            formResponse.bindingName,
        );
    }

    @vsCommand('openshift.component.dev')
    @clusterRequired()
    static async dev(component: ComponentWorkspaceFolder) {
        return Component.devRunOn(component, undefined);
    }

    static async devRunOn(component: ComponentWorkspaceFolder, runOn?: undefined | 'podman') {
        const cs = Component.getComponentDevState(component);
        cs.devStatus = ComponentContextState.DEV_STARTING;
        cs.runOn = runOn;
        Component.stateChanged.fire(component.contextPath)
        if (!runOn) {
            await CliChannel.getInstance().executeTool(Command.deletePreviouslyPushedResources(component.component.devfileData.devfile.metadata.name), undefined, false);
        }
        const outputEmitter = new EventEmitter<string>();
        let devProcess: ChildProcess;
        try {
            cs.devTerminal = window.createTerminal({
                name: component.contextPath,
                pty: {
                    onDidWrite: outputEmitter.event,
                    open: () => {
                        outputEmitter.fire(`Starting ${Command.dev(component.component.devfileData.supportedOdoFeatures.debug).toString()}\r\n`);
                        const opt: SpawnOptions = {cwd: component.contextPath};
                        void CliChannel.getInstance().spawnTool(Command.dev(component.component.devfileData.supportedOdoFeatures.debug, runOn), opt).then((cp) => {
                            devProcess = cp;
                            devProcess.on('spawn', () => {
                                cs.devTerminal.show();
                                cs.devProcess = devProcess;
                                cs.devStatus = ComponentContextState.DEV_RUNNING;
                                Component.stateChanged.fire(component.contextPath)
                            });
                            devProcess.on('error', (err)=> {
                                void window.showErrorMessage(err.message);
                                cs.devStatus = ComponentContextState.DEV;
                                Component.stateChanged.fire(component.contextPath)
                            })
                            devProcess.stdout.on('data', (chunk) => {
                                // TODO: test on macos (see https://github.com/redhat-developer/vscode-openshift-tools/issues/2607)
                                // it seems 'spawn' event is not firing on macos
                                if(cs.devStatus === ComponentContextState.DEV_STARTING) {
                                    cs.devStatus = ComponentContextState.DEV_RUNNING;
                                    Component.stateChanged.fire(component.contextPath)
                                }
                                outputEmitter.fire(`${chunk}`.replaceAll('\n', '\r\n'));
                            });
                            devProcess.stderr.on('data', (chunk) => {
                                if (!cs.devProcessStopRequest?.isSigabrtSent()) {
                                    outputEmitter.fire(`\x1b[31m${chunk}\x1b[0m`.replaceAll('\n', '\r\n'));
                                }
                            });
                            devProcess.on('exit', () => {
                                if (cs.devProcessStopRequest) {
                                    cs.devProcessStopRequest.dispose();
                                    cs.devProcessStopRequest = undefined;
                                }

                                outputEmitter.fire('\r\nPress any key to close this terminal\r\n');

                                cs.devStatus = ComponentContextState.DEV;
                                cs.devProcess = undefined;
                                Component.stateChanged.fire(component.contextPath)
                            });
                        });
                    },
                    close: () => {
                        if (cs.devProcess && cs.devProcess.exitCode === null && !cs.devProcessStopRequest) { // if process is still running and user closed terminal
                            cs.devStatus = ComponentContextState.DEV_STOPPING;
                            Component.stateChanged.fire(component.contextPath)
                            cs.devProcess.kill('SIGINT');
                            cs.devProcessStopRequest = Component.exitDevelopmentMode(cs.devProcess);
                        }
                        cs.devTerminal = undefined;
                    },
                    handleInput: ((data: string) => {
                        if (cs.devStatus !== ComponentContextState.DEV_STARTING) {
                            if(!cs.devProcess) { // if any key pressed after odo process ends
                                cs.devTerminal.dispose();
                            } else if (!cs.devProcessStopRequest && data.charCodeAt(0) === 3) { // ctrl+C processed only once when there is no cleaning process
                                outputEmitter.fire('^C\r\n');
                                cs.devStatus = ComponentContextState.DEV_STOPPING;
                                Component.stateChanged.fire(component.contextPath);
                                cs.devProcess.kill('SIGINT');
                                cs.devProcessStopRequest = Component.exitDevelopmentMode(cs.devProcess);
                            }
                        }
                    })
                },
            });
        } catch (err) {
            void window.showErrorMessage(err.toString());
        }
    }

    @vsCommand('openshift.component.exitDevMode')
    @clusterRequired()
    static async exitDevMode(component: ComponentWorkspaceFolder): Promise<void> {
        const componentState = Component.componentStates.get(component.contextPath)
        if (componentState) {
            componentState.devTerminal.show();
        }
        await commands.executeCommand('workbench.action.terminal.sendSequence', {text: '\u0003'});
    }

    @vsCommand('openshift.component.forceExitDevMode')
    @clusterRequired()
    static forceExitDevMode(component: ComponentWorkspaceFolder): Promise<void> {
        const componentState = Component.componentStates.get(component.contextPath)
        if (componentState.devProcess && componentState.devProcess.exitCode === null) {
            componentState.devProcessStopRequest.sendSigabrt();
        }
        return;
    }

    @vsCommand('openshift.component.openInBrowser')
    @clusterRequired()
    static async openInBrowser(component: ComponentWorkspaceFolder): Promise<string | null | undefined> {
        const componentDescription = await Component.odo.describeComponent(component.contextPath, !!Component.getComponentDevState(component).runOn);
        if (componentDescription.devForwardedPorts?.length === 1) {
            const fp = componentDescription.devForwardedPorts[0];
            await commands.executeCommand('vscode.open', Uri.parse(`http://${fp.localAddress}:${fp.localPort}`));
            return;
        } else if (componentDescription.devForwardedPorts?.length > 1) {
            const ports = componentDescription.devForwardedPorts.map((fp) => ({
                label: `${fp.localAddress}:${fp.localPort}`,
                description: `Forwards to ${fp.containerName}:${fp.containerPort}`,
            }));
            const port = await window.showQuickPick(ports, {placeHolder: 'Select a URL to open in default browser'});
            if(port) {
                await commands.executeCommand('vscode.open', Uri.parse(`http://${port.label}`));
                return;
            }
            return null;
        }
        return 'No forwarded ports available for component yet. Pleas wait and try again.';
    }

    static isUsingWebviewEditor(): boolean {
        return workspace
            .getConfiguration('openshiftToolkit')
            .get<boolean>('useWebviewInsteadOfTerminalView');
    }

    static createExperimentalEnv(componentFolder: ComponentWorkspaceFolder) {
        return Component.getComponentDevState(componentFolder).runOn ? {ODO_EXPERIMENTAL_MODE: 'true'} : {};
    }

    static getDevPlatform(componentFolder: ComponentWorkspaceFolder): string {
        return Component.getComponentDevState(componentFolder).runOn;
    }

    @vsCommand('openshift.component.describe', true)
    static describe(componentFolder: ComponentWorkspaceFolder): Promise<string> {
        const command = Command.describeComponent();
        const componentName = componentFolder.component.devfileData.devfile.metadata.name;
        if (Component.isUsingWebviewEditor()) {
            DescribeViewLoader.loadView(`${componentName} Description`, command, componentFolder);
        } else {
            void Component.odo.executeInTerminal(
                command,
                componentFolder.contextPath,
                `OpenShift: Describe '${componentName}' Component`);
        }
        return;
    }

    @vsCommand('openshift.component.log', true)
    static log(componentFolder: ComponentWorkspaceFolder): Promise<string> {
        const componentName = componentFolder.component.devfileData.devfile.metadata.name;
        const showLogCmd = Command.showLog(Component.getDevPlatform(componentFolder));
        if (Component.isUsingWebviewEditor()) {
            LogViewLoader.loadView(`${componentName} Log`, showLogCmd, componentFolder);
        } else {
            void Component.odo.executeInTerminal(
                showLogCmd,
                componentFolder.contextPath,
                `OpenShift: Show '${componentName}' Component Log`);
        }
        return;
    }

    @vsCommand('openshift.component.followLog', true)
    static followLog(componentFolder: ComponentWorkspaceFolder): Promise<string> {
        const componentName = componentFolder.component.devfileData.devfile.metadata.name;
        const showLogCmd = Command.showLogAndFollow(Component.getDevPlatform(componentFolder));
        if (Component.isUsingWebviewEditor()) {
            LogViewLoader.loadView(`${componentName} Follow Log`, showLogCmd, componentFolder);
        } else {
            void Component.odo.executeInTerminal(
                showLogCmd,
                componentFolder.contextPath,
                `OpenShift: Follow '${componentName}' Component Log`);
        }
        return;
    }

    @vsCommand('openshift.component.openCreateComponent')
    static async createComponent(): Promise<void> {
        await CreateComponentLoader.loadView('Create Component');
    }

    /**
     * Create a component
     *
     * @param folder The folder to use as component context folder
     * @param selection The folders selected in case of multiple selection in Explorer view.
     * @param context
     * @param componentTypeName
     * @param componentKind
     * @return A thenable that resolves to the message to show or empty string if components is already exists or null if command is canceled.
     * @throws VsCommandError or Error in case of error in cli or code
     */

    @vsCommand('openshift.component.createFromRootWorkspaceFolder')
    static async createFromRootWorkspaceFolder(folder: Uri, selection: Uri[], opts: {
        componentTypeName?: string,
        projectName?: string,
        applicationName?: string,
        compName?: string,
        registryName?: string
        devFilePath?: string
    }, isGitImportCall = false): Promise<string | null> {
        let useExistingDevfile = false;
        const devFileLocation = path.join(folder.fsPath, 'devfile.yaml');
        try {
            await fs.access(devFileLocation);
            useExistingDevfile = true;
        } catch (_e) {
            // do not use existing devfile
        }

        let initialNameValue: string;
        if (useExistingDevfile) {
            const file = await fs.readFile(devFileLocation, 'utf8');
            const devfileYaml = YAML.parse(file.toString());
            if (devfileYaml && devfileYaml.metadata && devfileYaml.metadata.name) {
                initialNameValue = devfileYaml.metadata.name;
            }
        }

        const progressIndicator = window.createQuickPick();

        let createStarter: string;
        let componentType: ComponentTypeAdapter;
        let componentTypeCandidates: ComponentTypeAdapter[];
        if (!useExistingDevfile && (!opts || !opts.devFilePath || opts.devFilePath.length === 0)) {
            const componentTypes = await Component.odo.getComponentTypes();
            progressIndicator.busy = true;
            progressIndicator.placeholder = opts?.componentTypeName ? `Checking if '${opts.componentTypeName}' Component type is available` : 'Loading available Component types';
            progressIndicator.show();
            if (opts?.componentTypeName) {
                componentTypeCandidates = opts.registryName && opts.registryName.length > 0 ? componentTypes.filter(type => type.name === opts.componentTypeName && type.registryName === opts.registryName) : componentTypes.filter(type => type.name === opts.componentTypeName);
                if (componentTypeCandidates?.length === 0) {
                    componentType = await window.showQuickPick(componentTypes.sort(ascDevfileFirst), { placeHolder: `Cannot find Component type '${opts.componentTypeName}', select one below to use instead`, ignoreFocusOut: true });
                } else if (componentTypeCandidates?.length > 1) {
                    componentType = await window.showQuickPick(componentTypeCandidates.sort(ascDevfileFirst), { placeHolder: `Found more than one Component types '${opts.componentTypeName}', select one below to use`, ignoreFocusOut: true });
                } else {
                    [componentType] = componentTypeCandidates;
                    progressIndicator.hide();
                }
            } else {
                componentType = await window.showQuickPick(componentTypes.sort(ascDevfileFirst), { placeHolder: 'Select Component type', ignoreFocusOut: true });
            }

            if (!componentType) return createCancelledResult('componentType');

            progressIndicator.placeholder = 'Checking if provided context folder is empty'
            progressIndicator.show();
            const workspacePath = `${folder.fsPath.replaceAll('\\', '/')}/`;
            const dirIsEmpty = (await fs.readdir(workspacePath)).length === 0;
            progressIndicator.hide();
            if (dirIsEmpty && !isGitImportCall) {
                if (opts?.projectName) {
                    createStarter = opts.projectName;
                } else {
                    progressIndicator.placeholder = 'Loading Starter Projects for selected Component Type'
                    progressIndicator.show();
                    const descr = await CliChannel.getInstance().executeTool(Command.describeCatalogComponent(componentType.name, componentType.registryName));
                    const starterProjects: StarterProject[] = Component.odo.loadItems<StarterProject>(descr, (data: ComponentTypeDescription[]) => {
                        const dfCompType = data.find((comp) => comp.registry.name === componentType.registryName);
                        return dfCompType.devfileData.devfile.starterProjects
                    });
                    progressIndicator.hide();
                    if (starterProjects?.length && starterProjects.length > 0) {
                        const create = await window.showQuickPick(['Yes', 'No'], { placeHolder: `Initialize Component using ${starterProjects.length === 1 ? '\''.concat(starterProjects[0].name.concat('\' ')) : ''}Starter Project?` });
                        if (create === 'Yes') {
                            if (starterProjects.length === 1) {
                                createStarter = starterProjects[0].name;
                            } else {
                                const selectedStarter = await window.showQuickPick(
                                    starterProjects.map(prj => ({ label: prj.name, description: prj.description })),
                                    { placeHolder: 'Select Starter Project to initialize Component' }
                                );
                                if (!selectedStarter) return createCancelledResult('selectStarterProject');
                                createStarter = selectedStarter.label;
                            }
                        } else if (!create) {
                            return createCancelledResult('useStaterProjectRequest');;
                        }
                    }
                }
            }
        }

        const componentName = opts?.compName || await Component.getName(
            'Name',
            Promise.resolve([]),
            initialNameValue?.trim().length > 0 ? initialNameValue : createStarter
        );

        if (!componentName) return createCancelledResult('componentName');
        const refreshComponentsView = workspace.getWorkspaceFolder(folder);
        const createComponentProperties: NewComponentCommandProps = {
            'component_kind': 'devfile',
            'component_type': componentType?.name,
            'component_version': componentType?.version,
            'starter_project': createStarter,
            'use_existing_devfile': useExistingDevfile,
        };
        try {
            await Progress.execFunctionWithProgress(
                `Creating new Component '${componentName}'`,
                () => Component.odo.createComponentFromFolder(
                    componentType?.name, // in case of using existing devfile
                    componentType?.registryName,
                    componentName,
                    folder,
                    createStarter,
                    useExistingDevfile,
                    opts?.devFilePath
                )
            );

            // when creating component based on existing workspace folder refresh components view
            if (refreshComponentsView) {
                commands.executeCommand('openshift.componentsView.refresh');
            }

            const result: any = new String(`Component '${componentName}' successfully created. Perform actions on it from Components View.`);
            result.properties = createComponentProperties;
            return result;
        } catch (err) {
            if (err instanceof VsCommandError) {
                throw new VsCommandError(
                    `Error occurred while creating Component '${componentName}': ${err.message}`,
                    `Error occurred while creating Component: ${err.telemetryMessage}`, err,
                    createComponentProperties
                );
            }
            throw err;
        }
    }

    @vsCommand('openshift.component.debug', true)
    static async debug(component: ComponentWorkspaceFolder): Promise<string | null> {
        if (!component) return null;
        if (Component.debugSessions.get(component.contextPath)) return Component.startDebugger(component);
        return Progress.execFunctionWithProgress(`Starting debugger session for the component '${component.component.devfileData.devfile.metadata.name}'.`, () => Component.startDebugger(component));
    }

    static async startDebugger(component: ComponentWorkspaceFolder): Promise<string | undefined> {
        let result: undefined | string | PromiseLike<string> = null;
        if (Component.debugSessions.get(component.contextPath)) {
            const choice = await window.showWarningMessage(`Debugger session is already running for ${component.component.devfileData.devfile.metadata.name}.`, 'Show \'Run and Debug\' view');
            if (choice) {
                commands.executeCommand('workbench.view.debug');
            }
            return result;
        }
        // const components = await Component.odo.getComponentTypes();
        const isJava = component.component.devfileData.devfile.metadata.tags.includes('Java') ;
        const isNode = component.component.devfileData.devfile.metadata.tags.includes('Node.js');
        const isPython = component.component.devfileData.devfile.metadata.tags.includes('Python');

        if (isJava || isNode || isPython) {
            if (isJava) {
                const JAVA_EXT = 'redhat.java';
                const JAVA_DEBUG_EXT = 'vscjava.vscode-java-debug';
                const jlsIsActive = extensions.getExtension(JAVA_EXT);
                const jdIsActive = extensions.getExtension(JAVA_DEBUG_EXT);
                if (!jlsIsActive || !jdIsActive) {
                    let warningMsg: string;
                    if (jlsIsActive && !jdIsActive) {
                        warningMsg = 'Debugger for Java (Publisher: Microsoft) extension is required to debug component';
                    } else if (!jlsIsActive && jdIsActive) {
                        warningMsg = 'Language support for Java ™ (Publisher: Red Hat) extension is required to support debugging.';
                    } else {
                        warningMsg = 'Language support for Java ™ and Debugger for Java extensions are required to debug component';
                    }
                    const response = await window.showWarningMessage(warningMsg, 'Install');
                    if (response === 'Install') {
                        await window.withProgress({ location: ProgressLocation.Notification }, async (progress) => {
                            progress.report({ message: 'Installing extensions required to debug Java Component ...' });
                            if (!jlsIsActive) await commands.executeCommand('workbench.extensions.installExtension', JAVA_EXT);
                            if (!jdIsActive) await commands.executeCommand('workbench.extensions.installExtension', JAVA_DEBUG_EXT);
                        });
                        await window.showInformationMessage('Please reload the window to activate installed extensions.', 'Reload');
                        await commands.executeCommand('workbench.action.reloadWindow');
                    }
                }
                if (jlsIsActive && jdIsActive) {
                    result = Component.startOdoAndConnectDebugger(component, {
                        name: `Attach to '${component.component.devfileData.devfile.metadata.name}' component.`,
                        type: 'java',
                        request: 'attach',
                        hostName: 'localhost',
                        projectName: path.basename(component.contextPath)
                    });
                }
            } else if (isPython) {
                const PYTHON_EXT = 'ms-python.python';
                const pythonExtIsInstalled = extensions.getExtension('ms-python.python');
                if (!pythonExtIsInstalled) {
                    const response = await window.showWarningMessage('Python extension (Publisher: Microsoft) is required to support debugging.', 'Install');
                    if (response === 'Install') {
                        await window.withProgress({ location: ProgressLocation.Notification }, async (progress) => {
                            progress.report({ message: 'Installing extensions required to debug Python Component ...' });
                            await commands.executeCommand('workbench.extensions.installExtension', PYTHON_EXT);
                        });
                        await window.showInformationMessage('Please reload the window to activate installed extension.', 'Reload');
                        await commands.executeCommand('workbench.action.reloadWindow');
                    }
                }
                if (pythonExtIsInstalled) {
                    result = Component.startOdoAndConnectDebugger(component, {
                        name: `Attach to '${component.component.devfileData.devfile.metadata.name}' component.`,
                        type: 'python',
                        request: 'attach',
                        connect: {
                            host: 'localhost'
                        },
                        pathMappings: [{
                            localRoot: component.contextPath,
                            remoteRoot: '/projects'
                        }],
                        projectName: path.basename(component.contextPath)
                    });
                }
            } else {
                result = Component.startOdoAndConnectDebugger(component, {
                    name: `Attach to '${component.component.devfileData.devfile.metadata.name}' component.`,
                    type: 'pwa-node',
                    request: 'attach',
                    address: 'localhost',
                    localRoot: component.contextPath,
                    remoteRoot: '/projects'
                });
            }
        } else {
            void window.showWarningMessage('Debug command currently supports local components with Java, Node.Js and Python component types.');
        }
        return result;
    }

    static async startOdoAndConnectDebugger(component: ComponentWorkspaceFolder, config: DebugConfiguration): Promise<string> {
            const componentDescription = await Component.odo.describeComponent(component.contextPath, !!Component.getComponentDevState(component).runOn);
            if (componentDescription.devForwardedPorts?.length > 0) {
                // try to find debug port
                const debugPortsCandidates:number[] = [];
                componentDescription.devForwardedPorts.forEach((pf) => {
                    const devComponent = componentDescription.devfileData.devfile.components.find(item => item.name === pf.containerName);
                    if (devComponent?.container) {
                        const candidatePort = devComponent.container.endpoints.find(endpoint => endpoint.targetPort === pf.containerPort);
                        if (candidatePort.name.startsWith('debug')) {
                            debugPortsCandidates.push(candidatePort.targetPort);
                        }
                    }
                });
                const filteredForwardedPorts = debugPortsCandidates.length > 0
                    ? componentDescription.devForwardedPorts.filter(fp => debugPortsCandidates.includes(fp.containerPort))
                        : componentDescription.devForwardedPorts;
                const ports = filteredForwardedPorts.map((fp) => ({
                    label: `${fp.localAddress}:${fp.localPort}`,
                    description: `Forwards to ${fp.containerName}:${fp.containerPort}`,
                    fp
                }));

                const port = ports.length === 1 ? ports[0] : await window.showQuickPick(ports, {placeHolder: 'Select a port to start debugger session'});

                if (!port) return null;

                config.contextPath = component.contextPath;
                if (config.type === 'python') {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                    config.connect.port = port.fp.localPort;
                } else {
                    config.port = port.fp.localPort;
                }

                const result = await debug.startDebugging(workspace.getWorkspaceFolder(Uri.file(component.contextPath)), config);

                if (!result) {
                    return Promise.reject(new VsCommandError('Debugger session failed to start.', undefined, undefined, {language: config.type}));
                }
                return createStartDebuggerResult(config.type, 'Debugger session has successfully started.');
            }
            return createStartDebuggerResult(config.type, 'Component has no ports forwarded.');
    }

    @vsCommand('openshift.component.revealContextInExplorer')
    public static async revealContextInExplorer(context: ComponentWorkspaceFolder): Promise<void> {
        await commands.executeCommand('workbench.view.explorer');
        await commands.executeCommand('revealInExplorer', context.contextPath);
    }

    @vsCommand('openshift.component.deploy')
    public static deploy(context: ComponentWorkspaceFolder) {
        // TODO: Find out details for deployment workflow
        // right now just let deploy and redeploy
        // Undeploy is not provided
        // --
        // const cs = Component.getComponentDevState(context);
        // cs.deployStatus = ComponentContextState.DEP_RUNNING;
        // Component.stateChanged.fire(context.contextPath);
        void Component.odo.executeInTerminal(
            Command.deploy(),
            context.contextPath,
            `OpenShift: Deploying '${context.component.devfileData.devfile.metadata.name}' Component`);
    }

    @vsCommand('openshift.component.undeploy')
    public static undeploy(context: ComponentWorkspaceFolder) {
        // TODO: Find out details for deployment workflow
        // right now just let deploy and redeploy
        // Undeploy is not provided
        // // --
        // const cs = Component.getComponentDevState(context);
        // cs.deployStatus = ComponentContextState.DEP;
        // Component.stateChanged.fire(context.contextPath);
        void Component.odo.executeInTerminal(
            Command.undeploy(context.component.devfileData.devfile.metadata.name),
            context.contextPath,
            `OpenShift: Undeploying '${context.component.devfileData.devfile.metadata.name}' Component`);
    }

    @vsCommand('openshift.component.deleteConfigurationFiles')
    public static async deleteConfigurationFiles(context: ComponentWorkspaceFolder): Promise<void> {
        const DELETE_CONFIGURATION = 'Delete Configuration';
        const CANCEL = 'Cancel';
        const response = await window.showWarningMessage(`Are you sure you want to delete the configuration for the component ${context.contextPath}?\nOpenShift Toolkit will no longer recognize the project as a component.`, DELETE_CONFIGURATION, CANCEL);
        if (response === DELETE_CONFIGURATION) {
            await Component.odo.deleteComponentConfiguration(context.contextPath);
            void commands.executeCommand('openshift.componentsView.refresh');
        }
    }

    @vsCommand('openshift.component.deleteSourceFolder')
    public static async deleteSourceFolder(context: ComponentWorkspaceFolder): Promise<void> {
        const DELETE_SOURCE_FOLDER = 'Delete Source Folder';
        const CANCEL = 'Cancel';
        const response = await window.showWarningMessage(`Are you sure you want to delete the folder containing the source code for ${context.contextPath}?`, DELETE_SOURCE_FOLDER, CANCEL);
        if (response === DELETE_SOURCE_FOLDER) {
            await fs.rm(context.contextPath, { force: true, recursive: true });
            let workspaceFolderToRmIndex = -1;
            for (let i = 0; i < workspace.workspaceFolders.length; i++) {
                if (workspace.workspaceFolders[i].uri.fsPath === context.contextPath) {
                    workspaceFolderToRmIndex = i;
                    break;
                }
            }
            if (workspaceFolderToRmIndex !== -1) {
                workspace.updateWorkspaceFolders(workspaceFolderToRmIndex, 1);
            }
        }
    }
}
