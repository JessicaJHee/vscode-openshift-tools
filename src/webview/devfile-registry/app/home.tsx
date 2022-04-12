/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import { makeStyles } from '@material-ui/core';
import { Link } from 'react-router-dom';
import {
    Gallery,
} from '@patternfly/react-core';
import React, { useEffect, useState } from 'react';
import { WrapperCardItem as CardItem } from './wrapperCardItem';
import homeStyle from './home.style';
import { LoadScreen } from './loading';
import { VSCodeMessage } from '../vsCodeMessage';
import { Data } from '../../../odo/componentTypeDescription';

const useStyles = makeStyles(homeStyle);

interface HomePageProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
    devFiles: Data[];
    homeStyleClass: any;
}

const HomeItem: React.FC<HomePageProps> = ({
    devFiles,
    homeStyleClass
}: HomePageProps) => {
    return (
        <>
            <Gallery className={homeStyleClass.devfileGalleryGrid}>
                {devFiles.map((devFile) => (
                    <Link
                        key={serializeURL(devFile.metadata.name)}
                        to={`/devfiles/${serializeURL(devFile.metadata.name)}`}
                        state={devFile}
                        className={homeStyleClass.textLink}>
                        <CardItem devFile={devFile} style={homeStyleClass} />
                    </Link>
                ))}
            </Gallery>
        </>
    );
};

export function Home() {
    const homeStyle = useStyles();
    const [devfiles, setDevFiles] = useState([]);
    useEffect(() => {
        return VSCodeMessage.onMessage((message) => {
            if (message.data.action === 'getAllComponents') {
                setDevFiles(message.data.devFiles)
            }
        }
        );
    });

    return (
        <div>
            {devfiles?.length > 0 ? <HomeItem devFiles={devfiles} homeStyleClass={homeStyle} /> :
                <LoadScreen />}
        </div>);
}

function serializeURL(name: string): string {
    return `Community+${name.replace(/\+/g, '')}`;
}
