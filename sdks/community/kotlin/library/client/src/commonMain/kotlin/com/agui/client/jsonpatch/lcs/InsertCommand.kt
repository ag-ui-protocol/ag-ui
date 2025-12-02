/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.agui.client.jsonpatch.lcs

/**
 * Command representing the insertion of one object of the second sequence.
 *
 *
 * When one object of the second sequence has no corresponding object in the
 * first sequence at the right place, the [edit script][EditScript]
 * transforming the first sequence into the second sequence uses an instance of
 * this class to represent the insertion of this object. The objects embedded in
 * these type of commands always come from the second sequence.
 *
 * @see SequencesComparator
 *
 * @see EditScript
 *
 *
 * @since 4.0
 * @version $Id: InsertCommand.java 1477760 2013-04-30 18:34:03Z tn $
 */
class InsertCommand<T>
/**
 * Simple constructor. Creates a new instance of InsertCommand
 *
 * @param object  the object of the second sequence that should be inserted
 */
    (`object`: T) : EditCommand<T>(`object`) {
    /**
     * Accept a visitor. When an `InsertCommand` accepts a visitor,
     * it calls its [visitInsertCommand][CommandVisitor.visitInsertCommand]
     * method.
     *
     * @param visitor  the visitor to be accepted
     */

    override fun accept(visitor: CommandVisitor<T>?) {
        visitor?.visitInsertCommand(`object`)
    }
}